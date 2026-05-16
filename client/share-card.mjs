// client/share-card.mjs — Carte de commandant exportable en PNG
//
// PROBLÈME : aucune viralité. Tu ne peux pas montrer ton empire à tes
// potes sans screen-shot d'un dashboard sec.
//
// SOLUTION : une vraie "trading card" générée par canvas 2D au pixel
// près. Sert aussi à invite-friend : QR code + lien vers
// `join-bitcoin.html`. On l'exporte en PNG via toDataURL.

const FONT_SERIF = '"Fraunces", "Georgia", serif';
const FONT_SANS  = '"Plus Jakarta Sans", system-ui, sans-serif';
const FONT_MONO  = '"JetBrains Mono", ui-monospace, monospace';

export function generateCommanderCard({
  pseudo = 'commandant',
  planetCount = 0,
  totalLevels = 0,
  rang = 'cadet',
  rangEmoji = '◦',
  tick = 0,
  achievements = 0,
  ferrum = 0,
  topRank = null, // rang dans classement, optionnel
} = {}) {
  const W = 1200, H = 630; // taille Twitter card classique
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  // Fond dégradé (or de bone + brass)
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#f7f0df');
  bg.addColorStop(0.6, '#e6d9bd');
  bg.addColorStop(1, '#c4b48a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Cadre intérieur
  ctx.strokeStyle = '#0e1d33';
  ctx.lineWidth = 2;
  ctx.strokeRect(40, 40, W - 80, H - 80);
  ctx.lineWidth = 1;
  ctx.strokeRect(46, 46, W - 92, H - 92);

  // Étoiles décoratives en arrière-plan
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * W;
    const y = Math.random() * H;
    const r = Math.random() * 1.4 + 0.2;
    ctx.fillStyle = `rgba(14,29,51,${0.10 + Math.random() * 0.25})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Header — eyebrow
  ctx.fillStyle = '#0e1d33';
  ctx.font = `500 13px ${FONT_MONO}`;
  ctx.textBaseline = 'top';
  ctx.fillText('CITADEL · ON-CHAIN COMMANDER', 80, 80);

  // Pseudo géant (serif Fraunces)
  ctx.fillStyle = '#0e1d33';
  ctx.font = `600 90px ${FONT_SERIF}`;
  ctx.fillText(pseudo.toUpperCase(), 80, 110);

  // Sous-titre rang + emoji
  ctx.fillStyle = 'rgba(14,29,51,0.7)';
  ctx.font = `500 26px ${FONT_SANS}`;
  ctx.fillText(`${rangEmoji}  ${rang}  ·  T${tick}`, 80, 220);

  // Trait
  ctx.strokeStyle = '#a83a25';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(80, 280);
  ctx.lineTo(280, 280);
  ctx.stroke();

  // Bloc stats (grille 3 colonnes)
  const statsY = 320;
  const cols = [
    { lab: 'PLANÈTES',     val: String(planetCount) },
    { lab: 'NIVEAUX',      val: String(totalLevels) },
    { lab: 'ACHIEVEMENTS', val: String(achievements) },
  ];
  cols.forEach((c, i) => {
    const x = 80 + i * 230;
    ctx.fillStyle = 'rgba(14,29,51,0.55)';
    ctx.font = `500 13px ${FONT_MONO}`;
    ctx.fillText(c.lab, x, statsY);
    ctx.fillStyle = '#0e1d33';
    ctx.font = `600 56px ${FONT_SERIF}`;
    ctx.fillText(c.val, x, statsY + 24);
  });

  // Ferrum (highlight)
  ctx.fillStyle = 'rgba(14,29,51,0.55)';
  ctx.font = `500 13px ${FONT_MONO}`;
  ctx.fillText('STOCK FERRUM', 770, statsY);
  ctx.fillStyle = '#a83a25';
  ctx.font = `600 56px ${FONT_SERIF}`;
  ctx.fillText(fmtCompact(ferrum), 770, statsY + 24);

  // Footer — devise
  ctx.fillStyle = '#0e1d33';
  ctx.font = `italic 500 22px ${FONT_SERIF}`;
  const motto = topRank
    ? `« Top ${topRank} de la galaxie. »`
    : `« Bâtir une légende sur la chaîne. »`;
  ctx.fillText(motto, 80, H - 130);

  // URL d'invite (sans dépendance externe)
  ctx.fillStyle = 'rgba(14,29,51,0.7)';
  ctx.font = `500 14px ${FONT_MONO}`;
  ctx.fillText('citadel.protocol · mutinynet · join-bitcoin.html', 80, H - 90);

  // Mark CITADEL en bas-droite
  ctx.fillStyle = '#0e1d33';
  ctx.font = `700 22px ${FONT_SERIF}`;
  ctx.textAlign = 'right';
  ctx.fillText('CITADEL', W - 80, H - 90);
  ctx.textAlign = 'left';

  return cv;
}

function fmtCompact(n) {
  if (!isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(1) + 'G';
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n | 0);
}

export function downloadCardPNG(canvas, filename = 'citadel-commander.png') {
  const url = canvas.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
}

export function shareToTwitter({ pseudo, tick }) {
  const text = encodeURIComponent(
    `Je suis @${pseudo} sur CITADEL — un 4X qui vit dans Bitcoin (Mutinynet).\n` +
    `Tick T${tick}. Pas de serveur, pas de compte, juste ma pubkey.\n\n` +
    `→ https://meffysto.codeberg.page/aetheris-protocol/join-bitcoin.html`
  );
  window.open(`https://twitter.com/intent/tweet?text=${text}`, '_blank', 'noopener');
}
