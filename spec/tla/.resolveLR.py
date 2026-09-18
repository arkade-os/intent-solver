import io
def box(s, w=77):
    b = " " + s
    assert len(b) <= w - 4, ("OVERFLOW %d" % (len(b) - (w - 4)), s)
    return "(*" + b.ljust(w - 4) + "*)"
p = "LightningReceive.tla"
s = io.open(p, encoding="utf-8", newline="").read()

# 1. resolve the conflict: main's CONTENT, my CITATION FORM
start = s.index("<<<<<<< HEAD")
end = s.index("\n", s.index(">>>>>>> 29dd745")) + 1
merged = "\n".join([
 box("THE EDGE TABLE.  Diff this against LEGAL_EDGES in"),
 box("packages/solver-corridors/src/db/receiveSwaps.ts — it now matches line"),
 box("for line, funded -> refunded included.  That edge was spec-only until"),
 box("packages/solver-arkade/src/arkade/unilateralExit.ts shipped the leaf;"),
 box("it exists here because gate (d)'s protection is unverifiable without"),
 box("the leaf it prices — the same contract-first stance as"),
 box("ArkadeHonoursFundKey.  The shipped table gained it in #184: the solo"),
 box("exit needs neither the Arkade Service nor refund_locktime, so it lands"),
 box("on a row still `funded`, and refunding -> refunded cannot record that."),
 box("The edge RECORDS an exit; it does not drive one.  startUnilateralExit"),
 box("ships and spends the leaf, but only when an operator runs it"),
 box("(cli unilateral-exit --go) and no sweep takes this edge, so"),
 box("FundedSoloRefund stays a requirement on the recovery software rather"),
 box("than a description of it."),
]) + "\n"
s = s[:start] + merged + s[end:]

# 2. the header edge listing now carries `refunded`
old = "(*   funded:    ['claimed', 'refunding', 'stuck']                          *)"
assert s.count(old) == 1
s = s.replace(old, box("  funded:    ['claimed', 'refunding', 'refunded', 'stuck']"))

# 3. (A4): the gap is CLOSED; my note said it was open
oldA4 = "\n".join([
 "(*       operator-driven.  What has NOT: receiveSwaps.ts's LEGAL_EDGES      *)",
 "(*       still lacks funded -> refunded, so transition() would refuse to    *)",
 "(*       record such an exit.  Re-read F5 against both; tracked as          *)",
 "(*       issue #184.                                                        *)"])
assert s.count(oldA4) == 1, s.count(oldA4)
s = s.replace(oldA4, "\n".join([
 box("      operator-driven.  receiveSwaps.ts's LEGAL_EDGES has since", 78),
 box("      gained funded -> refunded (#184), so transition() can now", 78),
 box("      record such an exit; no sweep takes that edge, so F5 stays a", 78),
 box("      requirement on the recovery software, not a description of it.", 78)]))

# 4. the Censored RESULTS row said the edge was missing
oldR = "\n".join([
 "(*                                       (arkade/unilateralExit.ts) but is *)",
 "(*                                       operator-driven and has no        *)",
 "(*                                       LEGAL_EDGES entry (#184), so a    *)"])
assert s.count(oldR) == 1, s.count(oldR)
s = s.replace(oldR, "\n".join([
 box("                                      (arkade/unilateralExit.ts) and"),
 box("                                      its LEGAL_EDGES entry landed"),
 box("                                      (#184), but it is operator-run,"),
 box("                                      so a")]))

io.open(p, "w", encoding="utf-8", newline="").write(s)
print("LightningReceive resolved")
