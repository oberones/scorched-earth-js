const Leaderboard = (() => {
  const limit = 10;
  const comparePerformance = (a, b) => b.score - a.score || b.kills - a.kills;

  function rank(entries) {
    const best = new Map();
    for (const entry of entries) {
      if (!entry || typeof entry.name !== 'string') continue;
      const { score, kills, rounds } = entry;
      const name = entry.name.trim();
      if (!name || name.length > 16 || !Number.isSafeInteger(score) ||
          !Number.isSafeInteger(kills) || kills < 0 ||
          !Number.isInteger(rounds) || rounds < 1 || rounds > 10) continue;
      const key = name.toLowerCase();
      const current = best.get(key);
      if (!current || comparePerformance(entry, current) < 0) {
        best.set(key, { name, score, kills, rounds });
      }
    }
    return Array.from(best.values()).sort((a, b) =>
      comparePerformance(a, b) || a.name.localeCompare(b.name, 'en') ||
      (a.name < b.name ? -1 : 1)
    ).slice(0, limit);
  }

  function fromMatch(game) {
    return game.tanks.filter(tank => tank.type === 'human').map(({ name, score, kills }) =>
      ({ name, score, kills, rounds: game.round })
    );
  }

  return { rank, fromMatch };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Leaderboard;
