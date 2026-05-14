// Mapping bloc Bitcoin ↔ tick. Fonctions pures.
//
// Le tick courant est dérivé du tip Bitcoin (ADR-0001) : aucune horloge
// serveur ne fait foi. Pour un (genesisBlock, blocsParTick, tickGenesis)
// donné, tous les clients calculent exactement le même tick.

/**
 * Calcule le tick courant à partir de la hauteur de bloc Bitcoin.
 *
 * @param {number} currentHeight   Hauteur actuelle (tip)
 * @param {number} genesisBlock    Bloc Bitcoin où le serveur démarre
 * @param {number} [blocsParTick=1]
 * @param {number} [tickGenesis=0] Tick associé à genesisBlock
 * @returns {number} Tick courant (clampé ≥ tickGenesis)
 */
export function tickFromBlockHeight(currentHeight, genesisBlock, blocsParTick = 1, tickGenesis = 0) {
  if (currentHeight < genesisBlock) return tickGenesis;
  return tickGenesis + Math.floor((currentHeight - genesisBlock) / blocsParTick);
}

/**
 * Hauteur de bloc Bitcoin où le tick `targetTick` se résout.
 */
export function blockHeightForTick(targetTick, genesisBlock, blocsParTick = 1, tickGenesis = 0) {
  return genesisBlock + (targetTick - tickGenesis) * blocsParTick;
}
