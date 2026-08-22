import { verifyCommitment } from '@keydate/netcode';

/**
 * All DOM outside the canvas: chips, the table panel, chat, and the fairness
 * readout.
 *
 * Kept apart from the renderer because it updates on events rather than every
 * frame — rebuilding the betting UI 60 times a second would fight the player's
 * own clicks.
 */

/** Used until a table says otherwise, so the box is never unbounded. */
const MIN_STAKE_FLOOR = 10;

/** Gap between cards as they are dealt out, in milliseconds. */
const DEAL_STAGGER_MS = 110;

export class Hud {
  /** @param {import('./net.js').Connection} connection */
  constructor(connection) {
    this.connection = connection;
    this.stake = 50;
    this.currentTableId = null;

    this.elements = {
      hud: document.getElementById('hud'),
      chips: document.getElementById('chips-value'),
      session: document.getElementById('session-value'),
      ping: document.getElementById('ping-value'),
      viewToggle: document.getElementById('view-toggle'),
      interactPrompt: document.getElementById('interact-prompt'),
      interactLabel: document.getElementById('interact-label'),
      tablePanel: document.getElementById('table-panel'),
      tableTitle: document.getElementById('table-title'),
      tablePhase: document.getElementById('table-phase'),
      tableTimerBar: document.getElementById('table-timer-bar'),
      tableSpots: document.getElementById('table-spots'),
      dealButton: document.getElementById('deal-button'),
      stakeInput: document.getElementById('stake-input'),
      stakeLimits: document.getElementById('stake-limits'),
      tableHand: document.getElementById('table-hand'),
      handDealer: document.getElementById('hand-dealer'),
      handSeats: document.getElementById('hand-seats'),
      handActions: document.getElementById('hand-actions'),
      tableWagers: document.getElementById('table-wagers'),
      tableResult: document.getElementById('table-result'),
      fairness: document.getElementById('fairness'),
      clearBets: document.getElementById('clear-bets'),
      leaveTable: document.getElementById('leave-table'),
      drunkRow: document.getElementById('drunk-row'),
      drunkBar: document.getElementById('drunk-bar'),
      barPanel: document.getElementById('bar-panel'),
      barTitle: document.getElementById('bar-title'),
      barMenu: document.getElementById('bar-menu'),
      leaveBar: document.getElementById('leave-bar'),
      viewport: document.getElementById('viewport'),
      chatLog: document.getElementById('chat-log'),
      chatInput: document.getElementById('chat-input'),
    };

    this._lastCommitment = null;
    /** What the action buttons currently show, so they are rebuilt only on change. */
    this._actionSignature = '';
    /** Card rows on screen, keyed by seat, so new cards can animate in. */
    this._handRows = new Map();
    /** The round those rows belong to; a new round clears the felt. */
    this._handRound = null;
    /** The last hand we were shown, kept so the cards stay up while it resolves. */
    this._lastHandView = null;
    /** Limits for the table currently open, refreshed from its state. */
    this._limits = { min: MIN_STAKE_FLOOR, max: MIN_STAKE_FLOOR };

    this._bindActions();
  }

  _bindActions() {
    this.elements.clearBets.addEventListener('click', () => {
      this.connection.send({ type: 'table:clear' });
    });
    this.elements.leaveTable.addEventListener('click', () => {
      this.connection.send({ type: 'table:leave' });
    });
    this.elements.leaveBar.addEventListener('click', () => this.hideBar());

    this.elements.dealButton.addEventListener('click', () => {
      this.connection.send({ type: 'table:deal' });
    });

    // Clamped on commit rather than on every keystroke: correcting "1" to "10"
    // mid-type makes it impossible to reach 100.
    this.elements.stakeInput.addEventListener('change', () => this._commitStake());
    this.elements.stakeInput.addEventListener('blur', () => this._commitStake());
    this.elements.stakeInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      this._commitStake();
      this.elements.stakeInput.blur();
    });
  }

  /** Sets the stake and shows it, without going outside the table's limits. */
  _setStake(amount) {
    this.stake = this._clampStake(amount);
    this.elements.stakeInput.value = String(this.stake);
    this._refreshStakeLimits();
  }

  _commitStake() {
    this._setStake(Number.parseInt(this.elements.stakeInput.value, 10));
  }

  /**
   * Holds a typed amount inside [minimum, what you can actually cover].
   *
   * The server enforces both ends regardless — this only spares the player a
   * red error for a bet that was never going to be accepted.
   */
  _clampStake(amount) {
    const { min, max } = this._limits;
    if (!Number.isFinite(amount)) return min;
    return Math.max(min, Math.min(max, Math.floor(amount)));
  }

  /**
   * Re-reads the limits from the open table and the current balance.
   *
   * The ceiling is whichever is lower: the table's own maximum, or what is in
   * the player's stack. On blackjack there is no table maximum, so it is simply
   * the balance — bet what you hold.
   */
  _refreshStakeLimits(state) {
    if (state !== undefined) {
      this._limits = {
        min: state.minWager ?? MIN_STAKE_FLOOR,
        max: state.maxWager ?? MIN_STAKE_FLOOR,
      };
    }
    const chips = this.chips ?? 0;
    const min = this._limits.min;
    const ceiling = Math.max(min, Math.min(this._limits.max, chips));
    this._limits = { min, max: ceiling };

    this.elements.stakeInput.min = String(min);
    this.elements.stakeInput.max = String(ceiling);
    this.elements.stakeLimits.textContent =
      chips < min ? `You need ${min} to bet` : `${min} – ${ceiling.toLocaleString()}`;
    this.elements.stakeLimits.classList.toggle('bad', chips < min);

    // A stake left over from a richer moment must not sit in the box as an
    // amount the table will refuse.
    const held = this._clampStake(this.stake);
    if (held !== this.stake) {
      this.stake = held;
      this.elements.stakeInput.value = String(held);
    }
  }

  setChips(value) {
    this.chips = value;
    this.elements.chips.textContent = value.toLocaleString();
    // Affordability is re-evaluated whenever the balance moves, so a round that
    // just cleaned you out greys the menu out immediately.
    if (!this.elements.barPanel.hidden) this._refreshAffordability();
    // The bet ceiling is the balance, so it moves every time the balance does.
    if (!this.elements.tablePanel.hidden) this._refreshStakeLimits();
  }

  /**
   * Applies the drunk state: the meter, and the blur.
   *
   * The blur is a CSS filter on the canvas rather than a post-processing pass.
   * It costs nothing, it is GPU-accelerated everywhere including phones, and it
   * needs no addons beyond the three.js core this client already serves. A real
   * depth-of-field pass would look better and would be the first thing to reach
   * for if the effect ever needs to be more than "the room goes soft".
   */
  setDrunkenness(level) {
    const clamped = Math.max(0, Math.min(1, level ?? 0));
    this.drunkenness = clamped;
    if (this.onDrunkenness) this.onDrunkenness(clamped);

    this.elements.drunkRow.hidden = clamped <= 0.005;
    this.elements.drunkBar.style.width = `${clamped * 100}%`;

    // Deliberately gentle at the bottom of the range and steep at the top: one
    // pint should be a nudge, the fourth should hurt.
    const blur = 7 * clamped ** 1.7;
    const saturate = 1 + clamped * 0.35;
    this.elements.viewport.style.filter =
      clamped <= 0.005 ? '' : `blur(${blur.toFixed(2)}px) saturate(${saturate.toFixed(2)})`;
  }

  showBar(label, menu) {
    this.elements.barPanel.hidden = false;
    this.elements.barTitle.textContent = label;
    this.menu = menu;

    this.elements.barMenu.replaceChildren();
    for (const item of menu) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = item.effect < 0 ? 'drink sobering' : 'drink';
      button.dataset.drinkId = item.id;
      button.dataset.price = String(item.price);

      const name = document.createElement('span');
      name.className = 'drink-name';
      name.textContent = item.name;

      const price = document.createElement('span');
      price.className = 'drink-price';
      price.textContent = `${item.price}`;

      const description = document.createElement('span');
      description.className = 'drink-desc';
      description.textContent = item.description;

      button.append(name, price, description);
      button.addEventListener('click', () => {
        this.connection.send({ type: 'bar:buy', drinkId: item.id });
      });
      this.elements.barMenu.append(button);
    }

    this._refreshAffordability();
  }

  hideBar() {
    this.elements.barPanel.hidden = true;
  }

  /** Greys out anything the player cannot currently pay for. */
  _refreshAffordability() {
    for (const button of this.elements.barMenu.querySelectorAll('.drink')) {
      button.disabled = Number(button.dataset.price) > (this.chips ?? 0);
    }
  }

  setSession(code) {
    this.elements.session.textContent = code;
  }

  setPing(ms) {
    this.elements.ping.textContent = `${Math.round(ms)}ms`;
  }

  /** @param {string | null} prompt Full prompt text, or null to hide it. */
  showInteractPrompt(prompt) {
    if (prompt === null || prompt === undefined) {
      this.elements.interactPrompt.hidden = true;
      return;
    }
    this.elements.interactPrompt.hidden = false;
    this.elements.interactLabel.textContent = prompt;
  }

  /** Renders the table panel from a server table state event. */
  renderTable(state) {
    this.currentTableId = state.tableId;
    const panel = this.elements.tablePanel;
    panel.hidden = false;

    // Everything about the felt travels with the state — the name, the spots,
    // the limits, the window. Adding a game to the registry used to mean
    // editing a lookup table here too, and the two drifted the first time.
    this.elements.tableTitle.textContent = state.displayName ?? state.gameId;
    this.elements.tablePhase.textContent = this._phaseLabel(state);
    this.elements.tablePhase.dataset.phase = state.phase;

    // The betting window drives a shrinking bar rather than a number, because a
    // bar is readable out of the corner of your eye while you are looking around.
    // During a hand it shows the clock on whoever is to act, for the same reason.
    const timer = this._timerFraction(state);
    this.elements.tableTimerBar.style.width = `${Math.max(0, Math.min(1, timer)) * 100}%`;

    this._refreshStakeLimits(state);
    this._renderSpots(state);
    this._renderDealButton(state);
    this._renderHand(state);
    this._renderWagers(state);
    this._renderResult(state);
  }

  /**
   * The button that tells the dealer to go.
   *
   * Only on tables that wait to be asked. It is the thing that replaced the
   * betting clock, so it has to say plainly what it is waiting for: a bet, a
   * press, or the last call it already started.
   */
  _renderDealButton(state) {
    const button = this.elements.dealButton;
    if (!state.dealOnDemand) {
      button.hidden = true;
      return;
    }

    button.hidden = state.phase !== 'betting';
    if (button.hidden) return;

    const staked = state.wagers.some((wager) => wager.playerId === this.connection.playerId);

    if (state.dealCalled) {
      button.disabled = true;
      button.classList.add('counting');
      button.textContent = `Dealing in ${Math.ceil(state.bettingMsRemaining / 1000)}s — last call`;
      return;
    }

    button.classList.remove('counting');
    button.disabled = !staked;
    button.textContent = staked ? 'Deal' : 'Place a bet first';
  }

  _timerFraction(state) {
    if (state.phase === 'betting') {
      // An on-demand table reports 0 until the deal is called, which is exactly
      // right: there is no clock to draw, so the bar sits empty.
      return state.bettingMsRemaining / (state.bettingWindowMs || 20000);
    }
    if (state.phase === 'decisions' && state.decision) {
      // No window length is published for a turn, so it is normalised against
      // the longest one anybody gets. It only has to shrink believably.
      return state.decision.msRemaining / 15000;
    }
    return 0;
  }

  _phaseLabel(state) {
    switch (state.phase) {
      case 'idle':
        return 'Waiting for players';
      case 'betting':
        if (state.dealOnDemand) {
          return state.dealCalled
            ? `Last call — ${Math.ceil(state.bettingMsRemaining / 1000)}s`
            : 'Place your bet, then deal';
        }
        return `Place your bets — ${Math.ceil(state.bettingMsRemaining / 1000)}s`;
      case 'decisions': {
        const seconds = Math.ceil((state.decision?.msRemaining ?? 0) / 1000);
        return this._isMyTurn(state) ? `Your move — ${seconds}s` : 'Waiting on another player';
      }
      case 'resolving':
        return 'No more bets';
      case 'payout':
        return 'Paying out';
      default:
        return state.phase;
    }
  }

  _isMyTurn(state) {
    return state.decision?.actor === this.connection.playerId;
  }

  _renderSpots(state) {
    const spots = state.spots ?? [];
    const container = this.elements.tableSpots;

    // Rebuild only when the table changes, so clicking a spot does not destroy
    // the button under the player's finger mid-tap.
    if (container.dataset.gameId !== state.gameId) {
      container.dataset.gameId = state.gameId;
      container.replaceChildren();
      for (const spot of spots) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'spot';
        button.dataset.spotId = spot.id;

        // Built node by node rather than as an HTML string: these labels come
        // off the wire, and one day a game will want an ampersand in one.
        const label = document.createElement('span');
        label.className = 'spot-label';
        label.textContent = spot.label;

        const hint = document.createElement('span');
        hint.className = 'spot-hint';
        hint.textContent = spot.description ?? '';

        const stake = document.createElement('span');
        stake.className = 'spot-stake';

        button.append(label, hint, stake);
        button.addEventListener('click', () => {
          this.connection.send({ type: 'table:wager', spotId: spot.id, amount: this.stake });
        });
        container.append(button);
      }
      // Six-plus spots need a tighter grid than two do.
      container.classList.toggle('dense', spots.length > 4);
    }

    const open = state.phase === 'betting';
    for (const button of container.querySelectorAll('.spot')) {
      button.disabled = !open;
      const mine = state.wagers.find(
        (wager) =>
          wager.spotId === button.dataset.spotId && wager.playerId === this.connection.playerId,
      );
      button.querySelector('.spot-stake').textContent = mine ? `${mine.amount}` : '';
      button.classList.toggle('staked', Boolean(mine));
    }
  }

  /**
   * The hand in progress: the dealer, every seat, and your own buttons.
   *
   * Rebuilt from scratch on every update. The action buttons are the one thing
   * a player taps under time pressure, so they are also the one thing that must
   * never be stale — a Hit button left over from a hand that has already moved
   * on is worse than no button at all.
   */
  /**
   * The hand in progress: the dealer, every seat, and your own buttons.
   *
   * Kept on screen from the deal all the way through the payout, rather than
   * only while somebody is acting. The dealer drawing to seventeen is the most
   * interesting thing that happens in a round of blackjack, and it used to
   * happen entirely off screen — you were shown an empty panel and then a
   * sentence telling you what you had missed.
   *
   * Rows are updated in place, never rebuilt. That is what makes the deal
   * animation possible at all: a card animates because it is a *new* element,
   * so re-creating every card five times a second would either animate
   * everything constantly or animate nothing.
   */
  _renderHand(state) {
    const rows = this._handRows;
    const hand = this._handToShow(state);
    // Published so the renderer can put the same cards on the felt. Resolving
    // *which* hand to show is fiddly — live view, remembered view, or finished
    // result — and doing it twice is how the panel and the table would come to
    // disagree about what was dealt.
    this.currentHand = hand;

    this.elements.tableHand.hidden = hand === null;
    if (hand === null) {
      this._clearHand();
      return;
    }

    // A new round is a new shoe and a new deal; nothing carries over.
    if (this._handRound !== state.round) {
      this._handRound = state.round;
      this._clearHand();
    }

    const live = new Set();
    let dealt = 0;

    dealt += this._syncRow('dealer', this.elements.handDealer, {
      label: 'Dealer',
      cards: hand.dealer,
      note: hand.dealerNote,
      dealtSoFar: dealt,
    });

    for (const seat of hand.seats) {
      const key = `seat:${seat.key ?? seat.playerId}`;
      live.add(key);
      dealt += this._syncRow(key, this.elements.handSeats, {
        label: seat.label,
        cards: seat.cards,
        note: seat.note,
        mine: seat.mine,
        acting: seat.acting,
        outcome: seat.outcome,
        dealtSoFar: dealt,
      });
    }

    for (const [key, row] of rows) {
      if (key === 'dealer' || live.has(key)) continue;
      row.element.remove();
      rows.delete(key);
    }

    this._renderHandActions(state);
  }

  /**
   * Works out which hand to draw, from whichever source currently has one.
   *
   * Three of them, in order: the live decision view while somebody is acting,
   * the last view we were sent while the dealer plays it out (the server sends
   * no view during `resolving` — the result does not exist yet), and the
   * finished hands out of the result once it does.
   */
  _handToShow(state) {
    const detail = state.lastResult?.detail;
    if ((state.phase === 'payout' || state.phase === 'resolving') && detail?.hands !== undefined) {
      return {
        dealer: detail.dealer ?? [],
        dealerNote: detail.dealerBust
          ? `bust ${detail.dealerTotal}`
          : detail.dealerBlackjack
            ? 'blackjack'
            : String(detail.dealerTotal ?? ''),
        seats: (detail.hands ?? []).map((entry) => ({
          key: `${entry.playerId}:${entry.spotId ?? 'box-1'}`,
          playerId: entry.playerId,
          spotId: entry.spotId ?? 'box-1',
          label: this._handLabel(state, entry, detail.hands ?? []),
          cards: entry.cards,
          note: `${entry.total}${entry.doubled ? ' · doubled' : ''}`,
          outcome: entry.outcome,
          mine: entry.playerId === this.connection.playerId,
          acting: false,
        })),
      };
    }

    // Before the cards are out there is nothing to show, and last round's hand
    // must not linger on a felt that has been cleared for a new one.
    if (state.phase === 'idle' || state.phase === 'betting') return null;

    if (state.phase === 'decisions' && state.decision?.view?.hands !== undefined) {
      // Remembered so the cards stay up through `resolving`, during which the
      // server sends no view at all — the result does not exist yet.
      this._lastHandView = state.decision.view;
    }

    const view = this._lastHandView;
    if (view === null || view === undefined || view.hands === undefined) return null;

    const actor = state.decision?.actor ?? null;
    const hands = view.hands ?? [];
    // Only one hand is live at a time, and with three boxes to one player the
    // actor's id no longer identifies it. The first unfinished hand belonging to
    // the actor is the one on the clock.
    const activeKey = hands.find((entry) => entry.playerId === actor && !entry.finished);

    return {
      // A null in the card list renders face down — which is exactly what the
      // dealer's hole card is until the hand is over.
      dealer: view.dealerCards ?? (view.dealerUpcard ? [view.dealerUpcard, null] : []),
      dealerNote: view.dealerBlackjack ? 'blackjack' : '',
      seats: hands.map((entry) => ({
        key: `${entry.playerId}:${entry.spotId ?? 'box-1'}`,
        playerId: entry.playerId,
        spotId: entry.spotId ?? 'box-1',
        label: this._handLabel(state, entry, hands),
        cards: entry.cards,
        note: entry.bust
          ? 'bust'
          : entry.blackjack
            ? 'blackjack'
            : `${entry.soft ? 'soft ' : ''}${entry.total}${entry.doubled ? ' · doubled' : ''}`,
        outcome: '',
        mine: entry.playerId === this.connection.playerId,
        acting: entry === activeKey,
      })),
    };
  }

  /**
   * Names one hand.
   *
   * The box number only appears when the player is actually holding more than
   * one — "You · Box 1 · 100" on a single hand is noise, and the box numbers
   * are what tell three hands apart when there are three.
   */
  _handLabel(state, entry, allHands) {
    const who =
      entry.playerId === this.connection.playerId ? 'You' : this._seatLabel(state, entry.playerId);
    const boxes = allHands.filter((hand) => hand.playerId === entry.playerId).length;
    const box = boxes > 1 && entry.box ? ` · ${entry.box}` : '';
    const stake = entry.stake === undefined ? '' : ` · ${Number(entry.stake).toLocaleString()}`;
    return `${who}${box}${stake}`;
  }

  _clearHand() {
    for (const row of this._handRows.values()) {
      if (row.element.id !== 'hand-dealer') row.element.remove();
    }
    this._handRows.clear();
    this.elements.handDealer.replaceChildren();
    this.elements.handSeats.replaceChildren();
    this.elements.handActions.replaceChildren();
    this._actionSignature = '';
  }

  /**
   * Brings one row up to date, animating only what is genuinely new.
   *
   * Returns how many cards it animated, so the caller can keep staggering them
   * across rows — the deal should look like one continuous motion round the
   * table, not like every seat being dealt simultaneously.
   */
  _syncRow(key, parent, spec) {
    let row = this._handRows.get(key);
    if (row === undefined) {
      const element = parent.id === 'hand-dealer' ? parent : document.createElement('div');
      element.className = 'hand-row';

      const who = document.createElement('span');
      who.className = 'hand-who';
      const cards = document.createElement('span');
      cards.className = 'hand-cards';
      const note = document.createElement('span');
      note.className = 'hand-note';

      element.replaceChildren(who, cards, note);
      if (element !== parent) parent.append(element);

      row = { element, who, cards, note, shown: [] };
      this._handRows.set(key, row);
    }

    row.who.textContent = spec.label;
    row.note.textContent = spec.note ?? '';
    row.element.classList.toggle('mine', spec.mine === true);
    row.element.classList.toggle('acting', spec.acting === true);
    row.element.dataset.outcome = spec.outcome ?? '';

    return this._syncCards(row, spec.cards ?? [], spec.dealtSoFar ?? 0);
  }

  /** Diffs one row's cards, appending new ones and flipping revealed ones. */
  _syncCards(row, cards, dealtSoFar) {
    const codes = cards.map((card) => this._cardKey(card));
    let animated = 0;

    // The common case by far: the hand grew. Everything already on the felt
    // stays exactly where it is, and only the new cards are dealt in.
    const grew =
      codes.length >= row.shown.length && row.shown.every((code, index) => code === codes[index]);

    if (!grew) {
      // Something other than a draw changed — the dealer's hole card turning
      // face up is the one that matters. Replace in place, flipping whatever
      // was hidden and is now known.
      row.cards.replaceChildren();
      cards.forEach((card, index) => {
        const flipped = row.shown[index] === 'facedown' && codes[index] !== 'facedown';
        row.cards.append(this._cardElement(card, flipped ? 'flip' : null, 0));
      });
      row.shown = codes;
      return 0;
    }

    for (let index = row.shown.length; index < cards.length; index += 1) {
      row.cards.append(
        this._cardElement(cards[index], 'deal', (dealtSoFar + animated) * DEAL_STAGGER_MS),
      );
      animated += 1;
    }
    row.shown = codes;
    return animated;
  }

  _cardKey(card) {
    return card === null || card === undefined ? 'facedown' : `${card.rank}${card.suit}`;
  }

  /** One card. `motion` is 'deal' for a card coming off the shoe, 'flip' for a reveal. */
  _cardElement(card, motion, delayMs) {
    const element = document.createElement('span');
    if (card === null || card === undefined) {
      // The back is drawn in CSS rather than set as text. U+1F0A0 (🂠) is the
      // obvious choice and renders as a missing-glyph box on every machine that
      // does not ship a playing-card font, which is most of them.
      element.className = 'card facedown';
      element.setAttribute('aria-label', 'face down');
    } else {
      element.className = card.suit === '\u2665' || card.suit === '\u2666' ? 'card red' : 'card';
      element.textContent = `${card.rank}${card.suit}`;
    }
    if (motion !== null) {
      element.classList.add(motion === 'deal' ? 'dealing' : 'flipping');
      if (delayMs > 0) element.style.animationDelay = `${delayMs}ms`;
    }
    return element;
  }

  _renderHandActions(state) {
    const decision = state.phase === 'decisions' ? state.decision : null;

    // Table state arrives about five times a second. Rebuilding the buttons on
    // every one of those tears the button out from under the player's finger
    // between mousedown and mouseup, and the click never lands — so they are
    // rebuilt only when what is on offer actually changes.
    const offered = decision !== null && this._isMyTurn(state) ? (decision.actions ?? []) : [];
    const signature = `${decision?.actor ?? ''}:${offered.map((action) => action.id).join(',')}`;
    if (signature === this._actionSignature) return;
    this._actionSignature = signature;

    this.elements.handActions.replaceChildren();
    for (const action of offered) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'hand-action';
      button.dataset.actionId = action.id;

      const label = document.createElement('span');
      label.className = 'action-label';
      label.textContent = action.label;

      const hint = document.createElement('span');
      hint.className = 'action-hint';
      hint.textContent = action.hint;

      button.append(label, hint);
      button.addEventListener('click', () => {
        // Fire and forget: the server decides whether it was legal, and the
        // next table state is the answer.
        this.connection.send({ type: 'table:action', actionId: action.id });
      });
      this.elements.handActions.append(button);
    }
  }

  /**
   * Names another player by their seat.
   *
   * Nothing on the wire maps a player id to a display name — names ride on
   * entity snapshots, keyed by entity id, and the table speaks in player ids.
   * A seat number is what you would use across a real table anyway, and it does
   * not require inventing a second identity channel to get it.
   */
  _seatLabel(state, playerId) {
    const seat = state.seats?.find((entry) => entry.playerId === playerId);
    return seat === undefined ? 'Seat' : `Seat ${seat.seatIndex + 1}`;
  }

  _renderWagers(state) {
    const total = state.wagers.reduce((sum, wager) => sum + wager.amount, 0);
    this.elements.tableWagers.textContent =
      total === 0
        ? `${state.seats.length} seated · nothing staked yet`
        : `${state.seats.length} seated · ${total.toLocaleString()} chips on the felt`;
  }

  _renderResult(state) {
    const result = state.lastResult;
    const box = this.elements.tableResult;

    if (result === null) {
      box.hidden = true;
      // While a round is live, show the commitment that was published before
      // betting opened. That is the value the reveal will be checked against.
      this.elements.fairness.textContent =
        state.commitment === null
          ? ''
          : `Round ${state.commitment.nonce} commitment: ${state.commitment.digest}`;
      this._lastCommitment = state.commitment;
      return;
    }

    box.hidden = false;
    box.replaceChildren();

    const summary = document.createElement('div');
    summary.className = 'result-summary';
    summary.textContent = result.summary;
    box.append(summary);

    // Card games publish what was actually dealt. Showing it matters more here
    // than on the wheel: "banker wins" tells you nothing about why.
    if (typeof result.detail?.written === 'string') {
      const cards = document.createElement('div');
      cards.className = 'result-cards';
      cards.textContent = result.detail.written;
      box.append(cards);
    }

    // Your own line out of a multi-seat hand, so you do not have to work out
    // which of six results was yours.
    const mine = (result.detail?.hands ?? []).find(
      (hand) => hand.playerId === this.connection.playerId,
    );
    if (mine !== undefined) {
      const line = document.createElement('div');
      line.className = `result-mine result-${mine.outcome}`;
      line.textContent =
        mine.payout > 0
          ? `You ${mine.outcome === 'push' ? 'push' : mine.outcome} on ${mine.total} — ${mine.payout} back`
          : `You ${mine.outcome} on ${mine.total}`;
      box.append(line);
    }

    // Verify the revealed seed against the digest the server published *before*
    // any chips were placed. A mismatch means the outcome was not the one
    // committed to, and the player should know immediately.
    const commitment = this._lastCommitment;
    if (commitment !== null && result.reveal) {
      const ok = verifyCommitment(commitment.digest, result.reveal.seed, result.reveal.nonce);
      this.elements.fairness.textContent = ok
        ? `✓ Verified — seed ${result.reveal.seed} matches commitment ${commitment.digest}`
        : `✗ COMMITMENT MISMATCH — seed ${result.reveal.seed} does not match ${commitment.digest}`;
      this.elements.fairness.classList.toggle('bad', !ok);
    }
  }

  hideTable() {
    this.elements.tablePanel.hidden = true;
    this.elements.tableHand.hidden = true;
    this.elements.dealButton.hidden = true;
    this.elements.tableSpots.dataset.gameId = '';
    this.currentTableId = null;
    this.currentHand = null;
    // Standing up ends your involvement in that hand. Nothing about it should
    // still be on screen if you sit down somewhere else.
    this._lastHandView = null;
    this._handRound = null;
    this._clearHand();
  }

  addChatLine(from, text, channel) {
    const line = document.createElement('div');
    line.className = `chat-line chat-${channel}`;
    line.textContent = from === null ? text : `${from}: ${text}`;
    this.elements.chatLog.append(line);
    // Keep the log bounded; an all-night session should not grow the DOM forever.
    while (this.elements.chatLog.childElementCount > 60) {
      this.elements.chatLog.firstElementChild.remove();
    }
    this.elements.chatLog.scrollTop = this.elements.chatLog.scrollHeight;
  }

  show() {
    this.elements.hud.hidden = false;
  }
}
