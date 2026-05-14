// Helpers de rendu Markdown — purs, sans accès au state.
// Rapports d'espionnage, alertes interception, comptes-rendus de bataille,
// et empire.md lisible humain. Le frontmatter YAML rend ces fichiers
// parsables par un agent ou un client tier.

export function renderIntelReport({ att, cible, planete, defEmp, niveau, sondesLancees, detruites, tick }) {
  const lines = [];
  lines.push('---');
  lines.push(`type: rapport-espionnage`);
  lines.push(`tick: ${tick}`);
  lines.push(`cible: { joueur: ${cible.joueur}, planete: ${cible.planete} }`);
  lines.push(`niveau_intel: ${niveau}`);
  lines.push(`sondes_lancees: ${sondesLancees}`);
  lines.push(`sondes_detruites: ${detruites}`);
  lines.push('---');
  lines.push('');
  lines.push(`# Rapport d'espionnage — ${cible.joueur}/${cible.planete}`);
  lines.push('');
  lines.push(`Tick ${tick} · Niveau ${niveau}/5`);
  lines.push(`${sondesLancees} sondes lancées, ${detruites} interceptées.`);
  lines.push('');
  if (niveau === 0) {
    lines.push(`> ⚠ Toutes les sondes ont été détectées et détruites avant transmission utile.`);
    lines.push(`> Le défenseur **a été alerté** de la tentative d'intrusion.`);
  }
  if (niveau >= 1) {
    lines.push(`## Ressources`); lines.push('');
    for (const [r, info] of Object.entries(planete.ressources || {})) {
      lines.push(`- ${r} : **${(info.stock || 0).toLocaleString('fr-FR')}** (capacité ${(info.capacite || 0).toLocaleString('fr-FR')}, prod +${info.production_par_utj || 0}/UTJ)`);
    }
    lines.push('');
  }
  if (niveau >= 2) {
    lines.push(`## Flotte au sol`); lines.push('');
    const fl = planete.flotte_au_sol || {};
    if (Object.keys(fl).length === 0) lines.push('*aucune*');
    else for (const [t, n] of Object.entries(fl)) lines.push(`- ${t} : ${n.toLocaleString('fr-FR')}`);
    lines.push('');
  }
  if (niveau >= 3) {
    lines.push(`## Défenses`); lines.push('');
    const d = planete.defenses || {};
    if (Object.keys(d).length === 0) lines.push('*aucune*');
    else for (const [t, n] of Object.entries(d)) lines.push(`- ${t} : ${n.toLocaleString('fr-FR')}`);
    lines.push('');
  }
  if (niveau >= 4) {
    lines.push(`## Bâtiments`); lines.push('');
    for (const [b, niv] of Object.entries(planete.batiments || {})) lines.push(`- ${b} : niveau ${niv}`);
    lines.push('');
  }
  if (niveau >= 5) {
    lines.push(`## Recherches`); lines.push('');
    for (const [t, niv] of Object.entries(defEmp.recherche || {})) lines.push(`- ${t} : niveau ${niv}`);
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

export function renderAlerteEspionnage({ defenderName, planeteCible, att, detruites, tick }) {
  const lines = [];
  lines.push('---');
  lines.push(`type: alerte-espionnage`);
  lines.push(`tick: ${tick}`);
  lines.push(`planete: ${planeteCible}`);
  lines.push(`attaquant: ${att}`);
  lines.push(`sondes_interceptees: ${detruites}`);
  lines.push('---');
  lines.push('');
  lines.push(`# ⚠ Tentative d'espionnage interceptée`);
  lines.push('');
  lines.push(`Tick ${tick} · Planète **${planeteCible}**`);
  lines.push(`${detruites} sonde(s) appartenant à **${att}** ont été détectées et détruites par le contre-espionnage.`);
  return lines.join('\n') + '\n';
}

export function renderBattleReport({ att, def, cible, result, debris, pillage, tick }) {
  const lines = [];
  lines.push('---');
  lines.push(`type: bataille`);
  lines.push(`tick: ${tick}`);
  lines.push(`attaquant: ${att}`);
  lines.push(`defenseur: ${def}`);
  lines.push(`lieu: { joueur: ${def}, planete: ${cible.planete} }`);
  lines.push(`issue: ${result.issue}`);
  lines.push(`rondes: ${result.rondes.length}`);
  lines.push(`debris: { ferrum: ${debris.ferrum}, lumen: ${debris.lumen} }`);
  lines.push(`pillage: { ferrum: ${pillage.ferrum}, lumen: ${pillage.lumen}, plasmide: ${pillage.plasmide} }`);
  lines.push('---');
  lines.push('');
  lines.push(`# Bataille de ${cible.planete} — tick ${tick}`);
  lines.push('');
  lines.push(`**${att.toUpperCase()}** attaque **${def.toUpperCase()}** sur ${cible.planete}.`);
  lines.push('');
  lines.push(`## Forces engagées`);
  lines.push('');
  lines.push(`### Attaquant (${att})`);
  for (const [t, n] of Object.entries(result.attaquant_initial)) {
    lines.push(`- ${t} : ${n}  →  restant : ${result.attaquant_restant[t] || 0}`);
  }
  lines.push('');
  lines.push(`### Défenseur (${def})`);
  for (const [t, n] of Object.entries(result.defenseur_initial)) {
    lines.push(`- ${t} : ${n}  →  restant : ${result.defenseur_restant[t] || 0}`);
  }
  lines.push('');
  lines.push(`## Déroulé`);
  lines.push('');
  for (const r of result.rondes) {
    lines.push(`**Ronde ${r.ronde}** — tir A=${r.tir_attaquant} / D=${r.tir_defenseur}`);
    const pa = Object.entries(r.pertes_attaquant).map(([t, n]) => `${t} -${n}`).join(', ') || '—';
    const pd = Object.entries(r.pertes_defenseur).map(([t, n]) => `${t} -${n}`).join(', ') || '—';
    lines.push(`- pertes attaquant : ${pa}`);
    lines.push(`- pertes défenseur : ${pd}`);
    lines.push('');
  }
  lines.push(`## Résultat`);
  lines.push('');
  lines.push(`Issue : **${result.issue}**`);
  lines.push(`Champ de débris : ${debris.ferrum} ferrum / ${debris.lumen} lumen`);
  if (result.issue === 'victoire-attaquant') {
    lines.push(`Butin : ${pillage.ferrum} ferrum / ${pillage.lumen} lumen / ${pillage.plasmide} plasmide`);
  }
  return lines.join('\n') + '\n';
}

export function renderEmpireMd(emp) {
  let md = `# Empire de ${emp.joueur}\n\n`;
  md += `> Tick ${emp.tick} · Score ${emp.score_total} · Alliance ${emp.alliance || '—'}\n\n`;
  md += `## Planètes (${(emp.planetes || []).length})\n\n`;
  for (const p of emp.planetes || []) {
    md += `### ${p.nom} — ${p.coordonnees.join(':')} · *${p.type}*\n\n`;
    md += `| Ressource | Stock | Production/UTJ | Capacité |\n|---|---|---|---|\n`;
    for (const [k, v] of Object.entries(p.ressources)) {
      md += `| ${k} | ${v.stock?.toLocaleString('fr-FR')} | +${v.production_par_utj} | ${v.capacite?.toLocaleString('fr-FR')} |\n`;
    }
    md += `\n**Bâtiments** : `;
    md += Object.entries(p.batiments).map(([k, v]) => `${k} ${v}`).join(', ') + '\n\n';
    if ((p.file_chantier || []).length > 0) {
      md += `**File** : ${p.file_chantier.map(c => `${c.batiment}→${c.niveau_cible} (${c.fin_utj} UTJ)`).join(', ')}\n\n`;
    }
  }
  if ((emp.recherche || {}) && Object.keys(emp.recherche).length > 0) {
    md += `## Recherche\n\n`;
    for (const [k, v] of Object.entries(emp.recherche)) md += `- ${k} : niv ${v}\n`;
  }
  return md;
}
