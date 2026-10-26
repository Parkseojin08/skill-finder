// Counts searches in flight so background skill collection can step aside while the user is searching.
let active = 0;

export const searchActivity = {
  begin(): void {
    active++;
  },
  end(): void {
    active = Math.max(0, active - 1);
  },
  busy(): boolean {
    return active > 0;
  },
};
