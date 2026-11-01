export const GAP = 10;
const RATIO = 16 / 9;
// Lado a lado é mais natural em telas largas: aceita lives até 20% menores para ganhar uma coluna.
const PREFER_COLUMNS = 0.8;

// Escolhe o número de colunas para as lives (16:9) ocuparem o máximo da área disponível.
export function fitGrid(count: number, width: number, height: number) {
  const options = Array.from({ length: Math.max(count, 1) }, (_, i) => {
    const cols = i + 1;
    const rows = Math.ceil(count / cols);
    const w = Math.min((width - GAP * (cols - 1)) / cols, ((height - GAP * (rows - 1)) / rows) * RATIO);
    return { cols, width: Math.max(0, Math.floor(w)), height: Math.max(0, Math.floor(w / RATIO)) };
  });
  const largest = Math.max(...options.map((o) => o.width));
  return options.filter((o) => o.width >= largest * PREFER_COLUMNS).at(-1) || options[0];
}
