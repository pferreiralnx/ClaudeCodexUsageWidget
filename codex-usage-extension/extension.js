// Codex Usage — barra de progresso do uso do Codex (OpenAI) no lado ESQUERDO
// da barra de topo do GNOME. Lê o token de ~/.codex/auth.json (só leitura) e
// consulta https://chatgpt.com/backend-api/wham/usage.
//
// Barra principal = janela "primary" (sessão de 5h). O menu mostra sessão (5h)
// e semanal, cada uma com a percentagem e o tempo até ao reset.

import St from 'gi://St';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const AUTH_PATH = GLib.build_filenamev([GLib.get_home_dir(), '.codex', 'auth.json']);
const POLL_SECONDS = 90;
const TRACK_WIDTH = 64;   // largura da barra em px
const BAR_HEIGHT = 10;

function severityColor(pct) {
    if (pct === null || pct === undefined) return '#9aa0a6';
    if (pct >= 85) return '#e74c3c';
    if (pct >= 50) return '#e67e22';
    return '#2ecc71';
}

function bar(pct, cells = 6) {
    pct = Math.max(0, Math.min(100, pct ?? 0));
    const filled = Math.round((pct / 100) * cells);
    return '▰'.repeat(filled) + '▱'.repeat(cells - filled);
}

function human(seconds) {
    seconds = Math.max(0, Math.floor(seconds ?? 0));
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    return `${m}m`;
}

const CodexIndicator = GObject.registerClass(
class CodexIndicator extends PanelMenu.Button {
    _init(extPath) {
        super._init(0.0, 'Codex Usage', false);
        this._destroyed = false;
        this._session = new Soup.Session();
        this._lastData = null;
        this._lastError = null;
        this._failCount = 0;    // falhas consecutivas desde o último sucesso
        this._inFlight = false; // há um pedido a decorrer? (evita pedidos sobrepostos)
        this._retrySource = 0;  // id do timer de recuperação rápida
        this._rateLimitHits = 0; // 429 seguidos
        this._backoffUntil = 0;  // até quando (tempo monotónico, µs) não consultar

        const box = new St.BoxLayout({
            style_class: 'ai-usage-indicator',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._logo = new St.Icon({
            gicon: Gio.icon_new_for_string(`${extPath}/openai-logo.svg`),
            style_class: 'ai-usage-logo',
            icon_size: 18,
            y_align: Clutter.ActorAlign.CENTER,
        });
        // Calha com posicionamento fixo: o preenchimento fica preso em (0,0) e
        // cresce da esquerda para a direita (um St.Bin centrava-o).
        this._track = new St.Widget({
            style_class: 'ai-usage-track',
            layout_manager: new Clutter.FixedLayout(),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._track.set_size(TRACK_WIDTH, BAR_HEIGHT);
        this._fill = new St.Widget({style_class: 'ai-usage-fill'});
        this._fill.set_position(0, 0);
        this._fill.set_size(0, BAR_HEIGHT);
        this._track.add_child(this._fill);
        this._pct = new St.Label({
            text: '…',
            style_class: 'ai-usage-pct',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._logo);
        box.add_child(this._track);
        box.add_child(this._pct);
        this.add_child(box);

        // --- menu ---
        this._header = new PopupMenu.PopupMenuItem('Uso do Codex', {reactive: false});
        this._header.label.style = 'font-weight: bold;';
        this.menu.addMenuItem(this._header);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._row5h = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._rowWeek = new PopupMenu.PopupMenuItem('', {reactive: false});
        for (const r of [this._row5h, this._rowWeek])
            r.label.style = 'font-family: monospace;';
        this.menu.addMenuItem(this._row5h);
        this.menu.addMenuItem(this._rowWeek);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refresh = new PopupMenu.PopupMenuItem('Atualizar agora');
        refresh.connect('activate', () => this.refresh(true));
        this.menu.addMenuItem(refresh);

        this.connect('destroy', () => {
            this._destroyed = true;
            if (this._retrySource) { GLib.Source.remove(this._retrySource); this._retrySource = 0; }
        });
    }

    // Falha recuperável: mantém o último valor bom na barra (não a apaga) e tenta
    // outra vez daqui a poucos segundos. Uma falha pontual de rede ou um 429 não
    // deve deitar fora os dados que já tínhamos. Só limpamos os dados — mostrando
    // ⚠ — em erros persistentes de credenciais/autenticação.
    _softError(message, clearData = false, retry = true) {
        this._lastError = message;
        this._failCount++;
        if (clearData && this._failCount > 2) this._lastData = null;
        this._render();
        if (retry && this._failCount <= 5)
            this._scheduleRetry(Math.min(30, 6 * this._failCount));
    }

    // 429: tentar logo outra vez só prolonga o bloqueio. Sem nova tentativa rápida
    // e as consultas periódicas passam a ser espaçadas (3m, 6m, 12m, 15m…).
    _rateLimited() {
        this._rateLimitHits++;
        const wait = Math.min(900, POLL_SECONDS * 2 ** this._rateLimitHits);
        this._backoffUntil = GLib.get_monotonic_time() + wait * 1e6;
        this._softError(`Limite de pedidos (429) — nova tentativa em ${human(wait)}`, false, false);
    }

    _scheduleRetry(seconds) {
        if (this._destroyed || this._retrySource) return;
        this._retrySource = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._retrySource = 0;
            if (this._destroyed) return GLib.SOURCE_REMOVE;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    // force = pedido manual ("Atualizar agora"), que ignora a espera após um 429.
    refresh(force = false) {
        if (this._inFlight) return; // não sobrepor pedidos
        if (!force && GLib.get_monotonic_time() < this._backoffUntil) return;

        let token, account;
        try {
            const [, bytes] = GLib.file_get_contents(AUTH_PATH);
            const auth = JSON.parse(new TextDecoder().decode(bytes));
            token = auth?.tokens?.access_token;
            account = auth?.tokens?.account_id;
            if (!token) throw new Error('sem token');
        } catch (_e) {
            // Pode ser transitório: o Codex reescreve o ficheiro ao renovar o token
            // e podemos apanhá-lo a meio. Mantém a barra e tenta outra vez.
            this._softError('Sem credenciais — inicia sessão no Codex.', true);
            return;
        }

        const msg = Soup.Message.new('GET', USAGE_URL);
        const h = msg.get_request_headers();
        h.append('Authorization', `Bearer ${token}`);
        if (account) h.append('chatgpt-account-id', account);
        h.append('originator', 'codex_cli_rs');
        h.append('User-Agent', 'codex_cli_rs/0.166.0');
        h.append('Accept', 'application/json');

        this._inFlight = true;
        this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
            this._inFlight = false;
            if (this._destroyed) return;
            try {
                const b = session.send_and_read_finish(res);
                // status_code é um número simples; get_status() devolve o enum
                // Soup.Status, que não tem o 429 e rebenta ao convertê-lo.
                const status = msg.status_code;
                if (status === 200) {
                    this._lastData = JSON.parse(new TextDecoder().decode(b.get_data()));
                    this._lastError = null;
                    this._failCount = 0;
                    this._rateLimitHits = 0;
                    this._backoffUntil = 0;
                    this._render();
                    return;
                }
                if (status === 401 || status === 403) {
                    // Pode ser o token a ser renovado; só surge ⚠ se persistir.
                    this._softError('Sessão expirada — reautentica no Codex.', true);
                    return;
                }
                if (status === 429) {
                    this._rateLimited();
                    return;
                }
                // 5xx — transitório. Mantém o último valor bom.
                this._softError(`Erro HTTP ${status}`, false);
            } catch (e) {
                this._softError(`Falha: ${e.message}`, false);
            }
        });
    }

    _windows() {
        const rl = this._lastData?.rate_limit;
        const out = [];
        if (rl?.primary_window)
            out.push({
                title: 'Sessão (5h)',
                pct: rl.primary_window.used_percent,
                reset: rl.primary_window.reset_after_seconds,
            });
        if (rl?.secondary_window)
            out.push({
                title: 'Semanal',
                pct: rl.secondary_window.used_percent,
                reset: rl.secondary_window.reset_after_seconds,
            });
        return out;
    }

    _setRow(row, w) {
        if (!w) { row.visible = false; return; }
        row.visible = true;
        row.label.text =
            `${w.title.padEnd(12, ' ')}${bar(w.pct)}  ${Math.round(w.pct)}%   ↻ ${human(w.reset)}`;
    }

    _render() {
        const wins = this._windows();
        const primary = wins[0];
        if (primary) {
            const pct = Math.max(0, Math.min(100, primary.pct ?? 0));
            const color = severityColor(primary.pct);
            this._fill.set_width(Math.round((TRACK_WIDTH * pct) / 100));
            this._fill.style = `background-color: ${color}; border-radius: 5px;`;
            this._pct.text = `${Math.round(primary.pct)}%`;
            this._pct.style = `color: ${color};`;
            const plan = this._lastData?.plan_type;
            // Mantemos a barra com o último valor bom; se a última atualização
            // falhou, avisamos no menu sem apagar a barra do painel.
            this._header.label.text = this._lastError
                ? `Uso do Codex · desatualizado (${this._lastError})`
                : `Uso do Codex${plan ? ' · ' + plan : ''}`;
        } else {
            this._fill.set_width(0);
            this._pct.text = this._lastError ? '⚠' : '…';
            this._pct.style = '';
            this._header.label.text = this._lastError || 'A carregar…';
        }
        this._setRow(this._row5h, wins[0]);
        this._setRow(this._rowWeek, wins[1]);
    }
});

export default class CodexUsageExtension extends Extension {
    enable() {
        this._indicator = new CodexIndicator(this.path);
        // posição 2 no caixote ESQUERDO — logo a seguir ao Claude (posição 1),
        // ficando lado a lado a seguir a "Atividades".
        Main.panel.addToStatusArea('codex-usage', this._indicator, 2, 'left');
        this._indicator.refresh();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
            this._indicator?.refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._timer) {
            GLib.Source.remove(this._timer);
            this._timer = null;
        }
        this._indicator?.destroy();
        this._indicator = null;
    }
}
