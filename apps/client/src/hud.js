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
    /** Spot definitions for the table being played, keyed by game id. */
    this.spotsByGame = {
      'wheel-of-fortune': [
        { id: 'x2', label: '2x', hint: 'Even money' },
        { id: 'x3', label: '3x', hint: 'Pays 2 to 1' },
        { id: 'x9', label: '9x', hint: 'Pays 8 to 1 — true odds' },
        { id: 'x50', label: '50x', hint: 'Pays 49 to 1' },
      ],
      'high-card-duel': [{ id: 'ante', label: 'Ante', hint: 'Highest card takes the pot' }],
    };

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
      tableWagers: document.getElementById('table-wagers'),
      tableResult: document.getElementById('table-result'),
      fairness: document.getElementById('fairness'),
      stakeButtons: document.getElementById('stake-buttons'),
      stakeValue: document.getElementById('stake-value'),
      clearBets: document.getElementById('clear-bets'),
      leaveTable: document.getElementById('leave-table'),
      chatLog: document.getElementById('chat-log'),
      chatInput: document.getElementById('chat-input'),
    };

    this._lastCommitment = null;
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
  }

  setChips(value) {
    this.elements.chips.textContent = value.toLocaleString();
  }

  setSession(code) {
    this.elements.session.textContent = code;
  }

  setPing(ms) {
    this.elements.ping.textContent = `${Math.round(ms)}ms`;
  }

  showInteractPrompt(label) {
    if (label === null) {
      this.elements.interactPrompt.hidden = true;
      return;
    }
    this.elements.interactPrompt.hidden = false;
    this.elements.interactLabel.textContent = `Sit at ${label}`;
  }

  /** Renders the table panel from a server table state event. */
  renderTable(state) {
    this.currentTableId = state.tableId;
    const panel = this.elements.tablePanel;
    panel.hidden = false;

    this.elements.tableTitle.textContent =
      state.gameId === 'high-card-duel' ? 'High Card Duel' : 'Wheel of Fortune';
    this.elements.tablePhase.textContent = this._phaseLabel(state);
    this.elements.tablePhase.dataset.phase = state.phase;

    // The betting window drives a shrinking bar rather than a number, because a
    // bar is readable out of the corner of your eye while you are looking around.
    const total = state.gameId === 'high-card-duel' ? 15000 : 20000;
    const fraction = state.phase === 'betting' ? state.bettingMsRemaining / total : 0;
    this.elements.tableTimerBar.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;

    this._renderSpots(state);
    this._renderWagers(state);
    this._renderResult(state);
  }

  _phaseLabel(state) {
    switch (state.phase) {
      case 'idle':
        return 'Waiting for players';
      case 'betting':
        return `Place your bets — ${Math.ceil(state.bettingMsRemaining / 1000)}s`;
      case 'resolving':
        return 'No more bets';
      case 'payout':
        return 'Paying out';
      default:
        return state.phase;
    }
  }

  _renderSpots(state) {
    const spots = this.spotsByGame[state.gameId] ?? [];
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
        button.innerHTML = `<span class="spot-label">${spot.label}</span><span class="spot-hint">${spot.hint}</span><span class="spot-stake"></span>`;
        button.addEventListener('click', () => {
          this.connection.send({ type: 'table:wager', spotId: spot.id, amount: this.stake });
        });
        container.append(button);
      }
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
    box.textContent = result.summary;

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
