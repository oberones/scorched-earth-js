// Economy and shop-boundary saves shared by local games and the room server.
const Campaign = {
  available(settings, id) {
    const def = Object.hasOwn(WEAPONS, id) ? WEAPONS[id] : Object.hasOwn(ITEMS, id) && ITEMS[id];
    if (!def || def.infinite || def.level > settings.arms) return false;
    if (id === 'disrupter' && !settings.suspend || id === 'trigger' && settings.tunneling === 'off') return false;
    return settings.format !== 'simultaneous' || !(def.family === 'Guidance' || id === 'trigger' || id === 'fuel');
  },

  price(game, id) {
    const def = WEAPONS[id] || ITEMS[id];
    const factor = (game.marketPrices || {})[id] || 100;
    const rounds = id === 'autodefense' ? game.settings.rounds - game.round : 1;
    return Math.round(def.price * factor / 100) * rounds;
  },

  cash(game, tank, delta) {
    const balance = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, tank.money + delta));
    if (game.settings.teams === 'corporate') {
      for (const member of game.tanks) if (member.team === tank.team) member.money = balance;
    } else tank.money = balance;
  },

  trade(game, tank, id, buying) {
    if (game.phase !== 'shop' || !Campaign.available(game.settings, id)) return false;
    const def = WEAPONS[id] || ITEMS[id], price = Campaign.price(game, id);
    const bag = WEAPONS[id] ? tank.inventory : tank.items;
    const quantity = def.bundle * (id === 'fuel' ? 10 : 1);
    const owned = bag[id] || 0;
    if (buying ? tank.money < price || (id === 'autodefense' && owned) : owned < quantity) return false;
    Campaign.cash(game, tank, buying ? -price : Math.floor(price * 0.8));
    bag[id] = owned + (buying ? quantity : -quantity);
    game.demand[id] = (game.demand[id] || 0) + (buying ? 1 : -1);
    return true;
  },

  closeShop(game) {
    if (game.settings.market === 'on' && (game.round > 0 || game.settings.startingCash > 0)) {
      for (const id of [...WEAPON_ORDER, ...Object.keys(ITEMS)]) {
        const price = game.marketPrices[id] || 100;
        const change = game.demand[id] || -1;
        game.marketPrices[id] = Math.max(50, Math.min(250, price + change * 3));
      }
    }
    game.demand = {};
    game.shopper = 0;
  },

  worth(game, tank) {
    let assets = 0;
    for (const [id, count] of Object.entries({ ...tank.items, ...tank.inventory })) {
      if (!count || id === 'baby') continue;
      const def = WEAPONS[id] || ITEMS[id];
      assets += Math.floor(count * Campaign.price(game, id) * 0.8 / (def.bundle * (id === 'fuel' ? 10 : 1)));
    }
    return Math.min(Number.MAX_SAFE_INTEGER, tank.money + assets);
  },

  teams(game) {
    const groups = new Map();
    for (const tank of game.tanks) {
      const group = groups.get(tank.team) || { team: tank.team, score: 0, worth: 0 };
      group.score += tank.score;
      group.worth += Campaign.worth(game, tank) - (groups.has(tank.team) && game.settings.teams === 'corporate' ? tank.money : 0);
      groups.set(tank.team, group);
    }
    const key = game.settings.scoring === 'greedy' ? 'worth' : 'score';
    return [...groups.values()].sort((a, b) => b[key] - a[key] || a.team - b.team);
  },

  save(game) {
    if (game.phase !== 'shop') throw new Error('Save at the arms dealer.');
    const tanks = game.tanks.map(t => ({
      money: t.money, score: t.score, wins: t.wins, kills: t.kills, items: t.items,
      inventory: Object.fromEntries(Object.entries(t.inventory).filter(([id]) => id !== 'baby')),
      defense: t.defense, parachuteOn: t.parachuteOn, threshold: t.threshold, persona: t.persona,
    }));
    return JSON.stringify({ version: 1, settings: game.settings, round: game.round, rng: game.rng.s,
      shopper: game.shopper, prices: game.marketPrices, demand: game.demand, tanks });
  },

  restore(json) {
    const s = JSON.parse(json);
    const roster = s.settings?.players;
    if (s.version !== 1 || !Array.isArray(roster) || roster.length < 2 || roster.length > 10 ||
        !Array.isArray(s.tanks) || s.tanks.length !== roster.length || !Number.isInteger(s.rng) ||
        !Number.isInteger(s.round) || s.round < 0 || s.round >= s.settings.rounds ||
        !Number.isInteger(s.shopper) || s.shopper < 0 || s.shopper >= roster.filter(p => p.type === 'human').length ||
        !roster.every(p => typeof p.name === 'string' && ['ai', 'human'].includes(p.type) &&
          TEAM_COLORS.some(c => c.hex === p.color) && (!p.difficulty || Object.hasOwn(DIFFICULTY, p.difficulty)))) {
      throw new Error('Invalid campaign save.');
    }
    const game = new Game(s.settings);
    for (const [i, saved] of s.tanks.entries()) {
      const t = game.tanks[i];
      for (const key of ['money', 'score', 'wins', 'kills']) {
        if (!Number.isSafeInteger(saved[key])) throw new Error('Invalid saved balance or score.');
        t[key] = saved[key];
      }
      for (const [bag, catalog] of [['items', ITEMS], ['inventory', WEAPONS]]) {
        for (const [id, qty] of Object.entries(saved[bag])) {
          if (!Object.hasOwn(catalog, id) || id === 'baby' || !Number.isFinite(qty) || qty < 0)
            throw new Error('Invalid saved equipment.');
          t[bag][id] = qty;
        }
      }
      t.defense = ITEMS[saved.defense]?.strength ? saved.defense : null;
      t.parachuteOn = saved.parachuteOn !== false;
      t.threshold = Number.isFinite(saved.threshold) ? saved.threshold : 5;
      t.persona = PERSONAS.includes(saved.persona) ? saved.persona : null;
    }
    for (const [source, target] of [[s.prices, game.marketPrices], [s.demand, game.demand]]) {
      for (const [id, value] of Object.entries(source)) {
        if ((!Object.hasOwn(WEAPONS, id) && !Object.hasOwn(ITEMS, id)) || !Number.isSafeInteger(value))
          throw new Error('Invalid market data.');
        target[id] = value;
      }
    }
    game.shopper = s.shopper; game.round = s.round; game.rng.s = s.rng >>> 0;
    return game;
  },
};
