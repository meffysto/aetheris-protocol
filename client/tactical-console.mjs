// client/tactical-console.mjs — Console tactique
//
// Remplace l'ancien "Pont de commandement" (clicker). Plus de scan/combo
// /rang/rations : juste 4 boutons qui font des projections déterministes
// locales sur l'état du joueur (calculé par le replay déterministe).
//
// Tout est CLIENT-ONLY :
//   - aucune inscription
//   - aucune mutation d'état
//   - aucune dépendance au réseau
// Les handlers vivent dans app.js (qui a accès à `state`). Ce module
// expose juste le HTML du panneau et un binder qui re-délègue.

export function renderConsolePanel() {
  return `
<section class="tac-panel">
  <header class="tac-head">
    <div class="tac-title"><span class="tac-icon" aria-hidden="true">⚙</span> Console tactique</div>
    <div class="tac-sub">Simulations locales sur ton empire — gratuites, instantanées.</div>
  </header>
  <div class="tac-actions">
    <button type="button" class="tac-act" data-tactical="proj">
      <span class="tac-act-eyebrow">projection</span>
      <span class="tac-act-lbl">▸ Stock projeté · +10 ticks</span>
    </button>
    <button type="button" class="tac-act" data-tactical="roi">
      <span class="tac-act-eyebrow">optimisation</span>
      <span class="tac-act-lbl">▸ Meilleur upgrade (ROI)</span>
    </button>
    <button type="button" class="tac-act" data-tactical="cap">
      <span class="tac-act-eyebrow">capacité</span>
      <span class="tac-act-lbl">▸ Time-to-cap dépôt</span>
    </button>
    <button type="button" class="tac-act" data-tactical="advice">
      <span class="tac-act-eyebrow">conseil</span>
      <span class="tac-act-lbl">▸ Diagnostic global</span>
    </button>
  </div>
  <div class="tac-output" id="tacOutput" hidden></div>
</section>`;
}
