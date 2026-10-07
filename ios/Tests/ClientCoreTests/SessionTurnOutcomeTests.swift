import Foundation
import Testing
@testable import ClientCore

@Suite struct SessionTurnOutcomeTests {
    @Test func runningTurnDefaultsToCompletedAndResolvesOnIdle() {
        var verdict: SessionTurnOutcome? = nil
        var next: SessionTurnOutcome? = nil
        for status in [V2RuntimeStatus.pending, .running, .running] {
            (verdict, next) = SessionTurnOutcome.resolve(from: next, status: status)
            #expect(verdict == nil)
        }
        (verdict, next) = SessionTurnOutcome.resolve(from: next, status: .idle)
        #expect(verdict == .completed)
        #expect(next == nil)
    }

    @Test func stoppingOverridesTheVerdictUntilTheTurnResolves() {
        var next: SessionTurnOutcome? = SessionTurnOutcome.resolve(from: nil, status: .running).next
        next = SessionTurnOutcome.resolve(from: next, status: .stopping).next
        let (verdict, resolved) = SessionTurnOutcome.resolve(from: next, status: .idle)
        #expect(verdict == .interrupted)
        #expect(resolved == nil)
    }

    @Test func errorResolvesTheTurnWithoutOverridingTheInterruptVerdict() {
        var next: SessionTurnOutcome? = SessionTurnOutcome.resolve(from: nil, status: .running).next
        next = SessionTurnOutcome.resolve(from: next, status: .stopping).next
        let (verdict, resolved) = SessionTurnOutcome.resolve(from: next, status: .error)
        #expect(verdict == .interrupted)
        #expect(resolved == nil)
    }

    @Test func waitingAndBlockedStatusesKeepTheCurrentFold() {
        let started = SessionTurnOutcome.resolve(from: nil, status: .running).next
        for status in [V2RuntimeStatus.waitingApproval, .blocked, .stopping, .waiting] {
            let (verdict, next) = SessionTurnOutcome.resolve(from: started, status: status)
            #expect(verdict == nil)
            #expect(next == started || status == .stopping)
        }
    }

    @Test func aNewTurnAfterInterruptionReportsCompletionAgain() {
        var next: SessionTurnOutcome? = SessionTurnOutcome.resolve(from: nil, status: .stopping).next
        #expect(next == .interrupted)
        // The interruption resolves on idle; a fresh running turn resets the fold.
        var verdict = SessionTurnOutcome.resolve(from: next, status: .idle).verdict
        #expect(verdict == .interrupted)
        (verdict, next) = SessionTurnOutcome.resolve(from: nil, status: .running)
        #expect(verdict == nil && next == .completed)
        verdict = SessionTurnOutcome.resolve(from: next, status: .idle).verdict
        #expect(verdict == .completed)
    }
}
