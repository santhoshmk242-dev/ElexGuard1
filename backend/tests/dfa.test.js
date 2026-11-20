'use strict';
const { DFA, votingDfa } = require('../services/dfa/dfaEngine');
const def = require('../services/dfa/dfaDefinition');

const { STATES: S, SYMBOLS: A } = def;
const HAPPY = [A.AUTHENTICATE, A.VERIFY_EMAIL, A.VERIFY_IDENTITY, A.CONFIRM_ELIGIBILITY, A.REQUEST_BALLOT, A.SUBMIT_VOTE, A.COMPLETE_VOTING];

describe('DFA formal definition', () => {
  test('Q, Σ, q0 and F are as documented', () => {
    expect(votingDfa.states).toEqual(['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'SX']);
    expect(votingDfa.alphabet).toHaveLength(7);
    expect(votingDfa.initialState).toBe('S0');
    expect([...votingDfa.acceptingStates]).toEqual(['S7']);
    expect([...votingDfa.rejectingStates]).toEqual(['SX']);
  });

  test('δ is a total function over Q × Σ', () => {
    for (const q of votingDfa.states) {
      for (const a of votingDfa.alphabet) {
        expect(votingDfa.states).toContain(votingDfa.delta(q, a));
      }
    }
    expect(votingDfa.transitionTable()).toHaveLength(9 * 7);
  });
});

describe('DFA valid transitions', () => {
  test.each([
    ['S0', A.AUTHENTICATE, 'S1'],
    ['S1', A.VERIFY_EMAIL, 'S2'],
    ['S2', A.VERIFY_IDENTITY, 'S3'],
    ['S3', A.CONFIRM_ELIGIBILITY, 'S4'],
    ['S4', A.REQUEST_BALLOT, 'S5'],
    ['S5', A.REQUEST_BALLOT, 'S5'],
    ['S5', A.SUBMIT_VOTE, 'S6'],
    ['S6', A.COMPLETE_VOTING, 'S7'],
  ])('δ(%s, %s) = %s', (from, sym, to) => {
    expect(votingDfa.delta(from, sym)).toBe(to);
    expect(votingDfa.step(from, sym)).toMatchObject({ valid: true, to });
  });

  test('the complete legitimate voting session is accepted', () => {
    const r = votingDfa.run(HAPPY);
    expect(r.accepted).toBe(true);
    expect(r.finalState).toBe('S7');
    expect(r.path).toEqual(['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']);
  });

  test('repeated ballot requests (page refresh) stay accepted', () => {
    const w = [...HAPPY.slice(0, 5), A.REQUEST_BALLOT, A.REQUEST_BALLOT, ...HAPPY.slice(5)];
    expect(votingDfa.accepts(w)).toBe(true);
  });
});

describe('DFA invalid transitions (rejected)', () => {
  test('exactly 8 valid edges exist – every other (state, symbol) pair is rejected', () => {
    const valid = votingDfa.transitionTable().filter((r) => r.to !== 'SX');
    expect(valid).toHaveLength(8);
    const invalid = votingDfa.transitionTable().filter((r) => r.to === 'SX');
    expect(invalid).toHaveLength(9 * 7 - 8);
  });

  test('users cannot skip states', () => {
    expect(votingDfa.step(S.S0, A.REQUEST_BALLOT).valid).toBe(false); // unauthenticated → ballot
    expect(votingDfa.step(S.S1, A.REQUEST_BALLOT).valid).toBe(false); // unverified email → ballot
    expect(votingDfa.step(S.S2, A.CONFIRM_ELIGIBILITY).valid).toBe(false); // unapproved → eligible
    expect(votingDfa.step(S.S3, A.REQUEST_BALLOT).valid).toBe(false); // ineligible → ballot
    expect(votingDfa.step(S.S4, A.SUBMIT_VOTE).valid).toBe(false); // no ballot access → vote
    expect(votingDfa.step(S.S0, A.SUBMIT_VOTE).valid).toBe(false);
  });

  test('completed voters cannot vote again', () => {
    for (const a of votingDfa.alphabet) expect(votingDfa.step(S.S7, a).valid).toBe(false);
    expect(votingDfa.step(S.S6, A.SUBMIT_VOTE).valid).toBe(false);
    expect(votingDfa.step(S.S6, A.REQUEST_BALLOT).valid).toBe(false);
  });

  test('words that skip a symbol are rejected', () => {
    for (let skip = 0; skip < HAPPY.length - 1; skip += 1) {
      const w = HAPPY.filter((_, i) => i !== skip);
      expect(votingDfa.accepts(w)).toBe(false);
    }
  });

  test('a word that votes twice is rejected', () => {
    expect(votingDfa.accepts([...HAPPY, A.SUBMIT_VOTE])).toBe(false);
    expect(votingDfa.accepts([...HAPPY, A.REQUEST_BALLOT])).toBe(false);
  });

  test('the dead state SX is absorbing', () => {
    const r = votingDfa.run([A.SUBMIT_VOTE, A.AUTHENTICATE]);
    expect(r.finalState).toBe('SX');
    expect(votingDfa.isRejecting(r.finalState)).toBe(true);
    for (const a of votingDfa.alphabet) expect(votingDfa.delta('SX', a)).toBe('SX');
  });

  test('empty word is not accepted; unknown inputs throw / are invalid', () => {
    expect(votingDfa.accepts([])).toBe(false);
    expect(() => votingDfa.delta('S9', A.AUTHENTICATE)).toThrow();
    expect(() => votingDfa.delta('S0', 'HACK')).toThrow();
    expect(votingDfa.step('S0', 'HACK').valid).toBe(false);
  });

  test('allowedSymbols reports the legal moves of a state', () => {
    expect(votingDfa.allowedSymbols('S5').sort()).toEqual([A.REQUEST_BALLOT, A.SUBMIT_VOTE].sort());
    expect(votingDfa.allowedSymbols('S7')).toEqual([]);
  });

  test('a custom DFA instance can be built from another definition', () => {
    const tiny = new DFA({ ...def });
    expect(tiny.accepts(HAPPY)).toBe(true);
  });
});
