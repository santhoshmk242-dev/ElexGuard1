'use strict';
const def = require('./dfaDefinition');

class DFA {
  constructor(definition = def) {
    this.states = Object.values(definition.STATES);
    this.alphabet = Object.values(definition.SYMBOLS);
    this.initialState = definition.INITIAL_STATE;
    this.acceptingStates = new Set(definition.ACCEPTING_STATES);
    this.rejectingStates = new Set(definition.REJECTING_STATES);
    this.table = definition.TRANSITIONS;
    this.labels = definition.STATE_LABELS;
    this.deadState = [...this.rejectingStates][0];
  }

  isState(s) { return this.states.includes(s); }
  isSymbol(a) { return this.alphabet.includes(a); }

  /** δ(q, a) – total function; undefined edges lead to the dead state. */
  delta(state, symbol) {
    if (!this.isState(state)) throw new Error(`Unknown DFA state: ${state}`);
    if (!this.isSymbol(symbol)) throw new Error(`Symbol not in alphabet Σ: ${symbol}`);
    const next = this.table[state] && this.table[state][symbol];
    return next || this.deadState;
  }

  /** Returns a result object instead of throwing; used by the service layer. */
  step(state, symbol) {
    if (!this.isState(state) || !this.isSymbol(symbol)) {
      return { valid: false, from: state, symbol, to: this.deadState };
    }
    const to = this.delta(state, symbol);
    return { valid: !this.rejectingStates.has(to), from: state, symbol, to };
  }

  /** δ*(q, w) – extended transition function over a word. Stops in the dead state once entered. */
  run(word, start = this.initialState) {
    let state = start;
    const path = [state];
    for (const symbol of word) {
      state = this.delta(state, symbol);
      path.push(state);
      if (this.rejectingStates.has(state)) break;
    }
    return { finalState: state, path, accepted: this.acceptingStates.has(state) };
  }

  accepts(word) { return this.run(word).accepted; }
  isAccepting(state) { return this.acceptingStates.has(state); }
  isRejecting(state) { return this.rejectingStates.has(state); }

  /** The legal outgoing symbols of a state – used to give clear rejection messages. */
  allowedSymbols(state) { return Object.keys(this.table[state] || {}); }

  /** Human readable transition table (used by docs, the public API and tests). */
  transitionTable() {
    const rows = [];
    for (const s of this.states) {
      for (const a of this.alphabet) {
        rows.push({ from: s, symbol: a, to: this.delta(s, a) });
      }
    }
    return rows;
  }

  definition() {
    return {
      Q: this.states,
      Sigma: this.alphabet,
      q0: this.initialState,
      F: [...this.acceptingStates],
      rejecting: [...this.rejectingStates],
      labels: this.labels,
      delta: this.table,
    };
  }
}

module.exports = { DFA, votingDfa: new DFA() };
