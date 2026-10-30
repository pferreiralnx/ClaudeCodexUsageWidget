#!/usr/bin/env bash
# Constroi o pacote .deb "claude-codex-usage".
#
# As extensoes vao para uma area de staging dentro do pacote
# (/usr/share/claude-codex-usage). Ao instalar, o debconf pergunta quais
# instalar (Claude, Codex ou ambos) e o postinst copia so essas para o
# diretorio de extensoes do GNOME Shell.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="claude-codex-usage"
VERSION="$(awk -F': ' '/^Version:/{print $2}' "$DIR/packaging/DEBIAN/control")"
ARCH="all"

BUILD="$DIR/build"
ROOT="$BUILD/${PKG}_${VERSION}_${ARCH}"
OUT="$BUILD/${PKG}_${VERSION}_${ARCH}.deb"

echo "==> Limpar build anterior"
rm -rf "$ROOT" "$OUT"

echo "==> Criar arvore do pacote"
mkdir -p "$ROOT/DEBIAN"
mkdir -p "$ROOT/usr/share/$PKG/claude-usage-extension"
mkdir -p "$ROOT/usr/share/$PKG/codex-usage-extension"
mkdir -p "$ROOT/usr/share/doc/$PKG"

# Scripts de manutencao + templates do debconf
cp "$DIR/packaging/DEBIAN/templates" "$ROOT/DEBIAN/templates"
cp "$DIR/packaging/DEBIAN/config"    "$ROOT/DEBIAN/config"
cp "$DIR/packaging/DEBIAN/postinst"  "$ROOT/DEBIAN/postinst"
cp "$DIR/packaging/DEBIAN/postrm"    "$ROOT/DEBIAN/postrm"
chmod 0755 "$ROOT/DEBIAN/config" "$ROOT/DEBIAN/postinst" "$ROOT/DEBIAN/postrm"

# Ficheiros das extensoes (staging)
cp "$DIR/claude-usage-extension/metadata.json" \
   "$DIR/claude-usage-extension/extension.js" \
   "$DIR/claude-usage-extension/stylesheet.css" \
   "$DIR/claude-usage-extension/claude-logo.svg" \
   "$ROOT/usr/share/$PKG/claude-usage-extension/"

cp "$DIR/codex-usage-extension/metadata.json" \
   "$DIR/codex-usage-extension/extension.js" \
   "$DIR/codex-usage-extension/stylesheet.css" \
   "$DIR/codex-usage-extension/openai-logo.svg" \
   "$ROOT/usr/share/$PKG/codex-usage-extension/"

# Documentacao
cp "$DIR/README.md"          "$ROOT/usr/share/doc/$PKG/README.md"
cp "$DIR/packaging/copyright" "$ROOT/usr/share/doc/$PKG/copyright"

echo "==> Calcular Installed-Size e gerar control"
SIZE_KB="$(du -sk "$ROOT/usr" | awk '{print $1}')"
sed "s/@SIZE@/$SIZE_KB/" "$DIR/packaging/DEBIAN/control" > "$ROOT/DEBIAN/control"

echo "==> Permissoes dos ficheiros de dados"
find "$ROOT/usr" -type d -exec chmod 0755 {} +
find "$ROOT/usr" -type f -exec chmod 0644 {} +

echo "==> dpkg-deb --build"
dpkg-deb --root-owner-group --build "$ROOT" "$OUT" >/dev/null

echo
echo "Pacote criado: $OUT"
echo
echo "Instalar (com pergunta de qual escolher):"
echo "  sudo apt install $OUT        # ou: sudo dpkg -i $OUT"
echo
echo "Remover:"
echo "  sudo apt remove $PKG"
