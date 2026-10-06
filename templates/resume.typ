// JobForge resume template (Phase 4). One page.
// The renderer writes `data.json` alongside this file in a temp dir and compiles.

#let data = json("data.json")

#set document(title: data.at("name", default: "Resume"), author: data.at("name", default: ""))
#set page(paper: "us-letter", margin: (x: 0.6in, y: 0.55in))
#set text(size: 10pt)
#set par(leading: 0.5em, justify: false)
#show heading.where(level: 1): set text(size: 16pt, weight: "bold")
#show heading.where(level: 2): it => block(
  below: 0.3em, above: 0.9em,
  text(size: 10.5pt, weight: "bold", upper(it.body))
    + v(-0.4em) + line(length: 100%, stroke: 0.5pt),
)

= #data.at("name", default: "")

#let contact = data.at("contact", default: "")
#if contact != "" [#text(size: 9.5pt)[#contact] \ ]

#let headline = data.at("headline", default: "")
#if headline != "" [#text(size: 10.5pt, weight: "medium")[#headline] \ ]

#let summary = data.at("summary", default: "")
#if summary != "" [#summary]

#let skills = data.at("skills", default: ())
#if skills.len() > 0 [
  == Skills
  #skills.join(" · ")
]

#let sections = data.at("sections", default: ())
#for section in sections [
  == #section.title
  #for bullet in section.bullets [
    - #bullet
  ]
]
