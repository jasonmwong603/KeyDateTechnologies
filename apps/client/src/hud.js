import { verifyCommitment } from '@keydate/netcode';

/**
 * All DOM outside the canvas: chips, the table panel, chat, and the fairness
 * readout.
 *
 * Kept apart from the renderer because it updates on events rather than every
 * frame — rebuilding the betting UI 60 times a second would fight the player's
 * own clicks.
 */

const STAKE_STEPS = [10, 50, 250, 1000];

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
      tableHand: document.getElementById('table-hand'),
      handDealer: document.getElementById('hand-dealer'),
      handSeats: document.getElementById('hand-seats'),
      handActions: document.getElementById('hand-actions'),
      tableWagers: document.getElementById('table-wagers'),
      tableResult: document.getElementById('table-result'),
      fairness: document.getElementById('fairness'),
      stakeButtons: document.getElementById('stake-buttons'),
      stakeValue: document.getElementById('stake-value'),
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
    this._buildStakeButtons();
    this._bindActions();
  }

  _buildStakeButtons() {
    for (const amount of STAKE_STEPS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = String(amount);
      button.addEventListener('click', () => {
        this.stake = amount;
        this.elements.stakeValue.textContent = String(amount);
      });
      this.elements.stakeButtons.append(button);
    }
  }

  _bindActions() {
    this.elements.clearBets.addEventListener('click', () => {
      this.connection.send({ type: 'table:clear' });
    });
    this.elements.leaveTable.addEventListener('click', () => {
      this.connection.send({ type: 'table:leave' });
    });
    this.elements.leaveBar.addEventListener('click', () => this.hideBar());
  }

  setChips(value) {
    this.chips = value;
    this.elements.chips.textContent = value.toLocaleString();
    // Affordability is re-evaluated whenever the balance moves, so a round that
    // just cleaned you out greys the menu out immediately.
    if (!this.elements.barPanel.hidden) this._refreshAffordability();
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

    this._renderSpots(state);
    this._renderHand(state);
    this._renderWagers(state);
    this._renderResult(state);
  }

  _timerFraction(state) {
    if (state.phase === 'betting') {
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
  _renderHand(state) {
    const decision = state.phase === 'decisions' ? state.decision : null;
    this.elements.tableHand.hidden = decision === null;
    if (decision === null) {
      this.elements.handActions.replaceChildren();
      this._actionSignature = '';
      return;
    }

    const view = decision.view ?? {};
    this.elements.handDealer.replaceChildren(
      this._cardRow(
        'Dealer',
        view.dealerCards ?? (view.dealerUpcard ? [view.dealerUpcard, null] : []),
        view.dealerBlackjack ? 'blackjack' : '',
      ),
    );

    const seats = document.createDocumentFragment();
    for (const hand of view.hands ?? []) {
      const mine = hand.playerId === this.connection.playerId;
      const name = mine ? 'You' : this._seatLabel(state, hand.playerId);
      const note = hand.bust
        ? 'bust'
        : hand.blackjack
          ? 'blackjack'
          : `${hand.soft ? 'soft ' : ''}${hand.total}${hand.doubled ? ' · doubled' : ''}`;

      const row = this._cardRow(`${name} · ${hand.stake}`, hand.cards, note);
      row.classList.toggle('mine', mine);
      row.classList.toggle('acting', hand.playerId === decision.actor);
      seats.append(row);
    }
    this.elements.handSeats.replaceChildren(seats);

    // Table state arrives about five times a second. Rebuilding the buttons on
    // every one of those tears the button out from under the player's finger
    // between mousedown and mouseup, and the click never lands — so they are
    // rebuilt only when what is on offer actually changes.
    const offered = this._isMyTurn(state) ? (decision.actions ?? []) : [];
    const signature = `${decision.actor}:${offered.map((action) => action.id).join(',')}`;
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

  /** One labelled row of cards. A null card renders face down. */
  _cardRow(label, cards, note) {
    const row = document.createElement('div');
    row.className = 'hand-row';

    const who = document.createElement('span');
    who.className = 'hand-who';
    who.textContent = label;
    row.append(who);

    const held = document.createElement('span');
    held.className = 'hand-cards';
    for (const card of cards ?? []) {
      const chip = document.createElement('span');
      if (card === null || card === undefined) {
        chip.className = 'card facedown';
        chip.textContent = '🂠';
      } else {
        chip.className = card.suit === '♥' || card.suit === '♦' ? 'card red' : 'card';
        chip.textContent = `${card.rank}${card.suit}`;
      }
      held.append(chip);
    }
    row.append(held);

    if (note) {
      const tail = document.createElement('span');
      tail.className = 'hand-note';
      tail.textContent = note;
      row.append(tail);
    }
    return row;
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
    this.elements.handActions.replaceChildren();
    this.elements.tableSpots.dataset.gameId = '';
    this.currentTableId = null;
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
