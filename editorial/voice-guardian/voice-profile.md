# Voice Profile

What Voice Guardian checks a revision against. This doesn't define good prose. It's a record of what makes this writer sound like herself, and the choices a conventional editor would wrongly "fix."

The source of truth for voice is still `CLAUDE.md` / `AGENTS.md` at the repo root. This file restates those rules as things an evaluator can check, then adds what shows up in the published reference passages (`reference-passages.jsonl`).

---

## The core question

Does this passage keep the things that make the writer sound like herself? And did the revision **damage anything that was already working**?

An edit can be grammatically better and still make the work worse. The original may be better than every revision on the table. Saying so is a valid verdict.

---

## Fingerprint

**Rhythm.** A short declarative punch, then the longer sentence that earns it. One-line paragraphs carry weight. Fragments are deliberate: *Not intelligence. Not creativity. Not taste.* Evenly weighted, medium-length sentences mean the voice has gone flat.

**Narrator.** First person, present, opinionated. She catches herself mid-thought and corrects: "Or at least one of us does." Confession sits in plain sentences: "I got roasted for it. It hurt more than I wanted to admit." Nobody is narrating *at* the reader from a podium.

**Register shifts.** Wry humor, then sudden vulnerability. Technical specificity, then a gut-punch. A blindness joke, then *let in*. These turns are the point. Don't sand them down into one consistent tone.

**Specificity.** Concrete before abstract. Wet-glass raccoon eyes. A maroon salvage-shop skater skirt. Trucks for shoveling context into LLMs. Roll 7000 dice. Swapping a specific for a general category ("tools," "content," "the industry") is the most common way a revision damages this voice.

**Punctuation as voice.**
- Em-dashes for asides and interruptions. A thought breaks itself off mid-stride. A trailing em-dash cut off by dialogue is structural.
- Italics for emphasis on one word or phrase, never for decoration: *possible* / *visible*, *let in*, *is*.
- Parenthetical asides in fiction are often the character's own coping (Mr. Trout's diamond).

**Repetition is rhetoric.** Anaphora, triplets, and repetition kickers ("That's not a flaw. That's the feature." / "Both are subscriptions. Both are billing you.") are intentional. Don't consolidate them.

**Profanity and bluntness.** "Weird sons of bitches." "Absolute shitgoblins." Load-bearing. Not a tone problem.

**Politics stated, not hedged.** Trans identity, queer community, disability, labor, capitalism, technology. These aren't background texture. A revision that adds qualifiers, "balance," or "some would argue" is damage.

**Kickers.** Essays and sections end on one good line, often on its own: "We do." "There is only rabies." "My aliveness is not negotiable."

**Sources** get named or linked inline. No academic citation style.

---

## Genre differences

| Genre | Expect | Don't penalize |
|---|---|---|
| Polemic / argumentative essay | Thesis early, section breaks, kickers, fragments, repetition | Headers, `---` breaks, bold for the core claim |
| Personal / memoir essay | Confession, register shifts, sensory specifics | Long reflective paragraphs that end in a one-line turn |
| Blog | Starts mid-situation, no preamble, conversational | Lists when they're rhetorical |
| Fiction (any person) | Atmosphere through smell, texture, weight. Humor from character, not narrator winks. Clipped dialogue | Long run-on sentences when a character is spiraling. No headers |

Fiction can be third, first, or second person. Check before assuming. Fiction doesn't have to sound like the essay narrator. It has to sound like *her fiction*.

---

## What generic AI revision looks like here

- Concrete personal experience swapped for industry rhetoric ("unlocking the transformative potential of...").
- The narrator removed. "I" turned into "we," "one," or nobody.
- One-line paragraphs merged into tidy medium paragraphs.
- Em-dashes swapped for commas or semicolons. Fragments "fixed" into full sentences.
- Profanity, jokes, and asides cut as "unprofessional."
- Hedges added: perhaps, arguably, it's worth noting.
- Formulaic contrasts the author didn't write. She *does* use "It's not X. It's Y." herself, so judge whether this instance earns it.
- A tidy moral at the end where the original had a kicker or an open wound.

---

## Voice drift

A change in voice across a manuscript isn't automatically bad. The narrator's emotional state, a POV shift, or a different section function can all justify it. Drift reports describe the shift, show evidence, and ask whether it was intended. They don't render a verdict.
