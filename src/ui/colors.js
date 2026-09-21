// Player colours, by the colour index the host assigns (0 = host).
export const PLAYER_COLORS = ['#a8328f', '#1c7ed6', '#2b9348', '#e8590c', '#7048e8', '#0c8599', '#d6336c', '#846358'];

export function colorFor(index) {
  return PLAYER_COLORS[index] || PLAYER_COLORS[0];
}
