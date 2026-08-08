#let navy = rgb("#0B1220")
#let panel = rgb("#111827")
#let gold = rgb("#D4AF37")
#let border = rgb("#CBD5E1")
#let muted = rgb("#64748B")
#let pale = rgb("#F8FAFC")
#let green = rgb("#047857")

#set page(
  paper: "us-letter",
  margin: (x: 0.62in, y: 0.45in),
  fill: pale,
  footer: align(center)[
    #text(size: 7pt, fill: muted)[RWCAR · RWRN01 · SYNTHETIC TESTNET EVIDENCE · NO REAL-WORLD CLAIM]
  ],
)
#set text(font: "Libertinus Serif", size: 8.2pt, fill: navy)
#set par(leading: 0.58em)

#let label(body) = text(size: 7pt, weight: "bold", fill: muted, tracking: 0.5pt, upper(body))
#let value(body, mono: false) = text(size: if mono { 7pt } else { 9pt }, weight: "semibold", font: if mono { "DejaVu Sans Mono" } else { "Libertinus Serif" }, fill: navy, body)
#let field(name, body, mono: false) = block(
  width: 100%,
  fill: white,
  stroke: 0.6pt + border,
  radius: 5pt,
  inset: 7pt,
  [#label(name) #v(2pt) #value(body, mono: mono)],
)
#let section-title(number, title, subtitle) = [
  #grid(
    columns: (24pt, 1fr),
    gutter: 7pt,
    align: horizon,
    block(width: 23pt, height: 23pt, radius: 12pt, fill: gold, inset: 4pt)[
      #align(center + horizon)[#text(size: 8pt, weight: "bold", fill: navy)[#number]]
    ],
    [#text(size: 11pt, weight: "bold", fill: navy)[#title] #linebreak() #text(size: 7.3pt, fill: muted)[#subtitle]],
  )
  #v(5pt)
]

#block(width: 100%, fill: navy, radius: 8pt, inset: 14pt)[
  #grid(
    columns: (1fr, auto),
    gutter: 16pt,
    [
      #text(size: 8pt, weight: "bold", fill: gold, tracking: 1.2pt)[RWCAR / RWA REPO MARKET]
      #v(7pt)
      #text(size: 20pt, weight: "bold", fill: white)[Receivable Note]
      #v(2pt)
      #text(size: 11pt, fill: rgb("#CBD5E1"))[RWCAR Receivable Note I · RWRN01]
    ],
    align(right)[
      #block(fill: gold, radius: 4pt, inset: (x: 10pt, y: 7pt))[
        #text(size: 8pt, weight: "bold", fill: navy)[TESTNET ONLY]
      ]
    ],
  )
]

#v(7pt)
#block(width: 100%, fill: rgb("#FEF3C7"), stroke: 0.7pt + gold, radius: 5pt, inset: 8pt)[
  #text(size: 8.5pt, weight: "bold", fill: rgb("#92400E"))[SYNTHETIC DEMONSTRATION RECORD — NO REAL-WORLD CLAIM]
  #v(3pt)
  #text(size: 8pt, fill: rgb("#92400E"))[This document exists exclusively for a Monad Testnet hackathon demonstration. It is not an invoice, security, offer, debt instrument, or legally enforceable payment obligation.]
]

#v(8pt)
#section-title("01", "Document identity", "Canonical reference data for the synthetic UAT asset")
#grid(
  columns: (1fr, 1fr),
  gutter: 9pt,
  field("Document ID", [RWCAR-RWRN01-UAT-20260805-001]),
  field("Status", [Synthetic / Testnet / Non-enforceable]),
  field("Issue date", [August 5, 2026]),
  field("Reference due date", [September 5, 2026]),
)

#v(8pt)
#section-title("02", "Reference parties", "Fictional entities used only to exercise the protocol workflow")
#grid(
  columns: (1fr, 1fr),
  gutter: 9pt,
  field("Synthetic issuer", [RWCAR Demo Issuer]),
  field("Synthetic obligor", [Testnet Demo Buyer]),
)
#v(6pt)
#block(width: 100%, fill: white, stroke: 0.6pt + border, radius: 5pt, inset: 7pt)[
  #label([Purpose]) #v(4pt)
  This record models a short-dated commercial receivable so the RWCAR application can demonstrate compliant repo creation, delivery-versus-payment, maturity, repurchase, and default handling on Monad Testnet.
]

#v(8pt)
#section-title("03", "Reference economics", "Illustrative values for protocol testing; not a market valuation")
#grid(
  columns: (1fr, 1fr, 1fr),
  gutter: 8pt,
  field("Reference face value", [USD 100.00]),
  field("Token supply", [100 RWRN01]),
  field("Reference unit value", [USD 1.00]),
)
#v(6pt)
#grid(
  columns: (1fr, 1fr),
  gutter: 9pt,
  field("Reference term", [31 calendar days]),
  field("Currency", [USD]),
)

#pagebreak()

#block(width: 100%, fill: navy, radius: 8pt, inset: 12pt)[
  #grid(columns: (1fr, auto), gutter: 12pt,
    [#text(size: 15pt, weight: "bold", fill: white)[Verification Schedule] #linebreak() #text(size: 8pt, fill: rgb("#CBD5E1"))[RWRN01 issuance and valuation anchors]],
    [#text(size: 8pt, weight: "bold", fill: gold)[TESTNET ONLY]],
  )
]

#v(8pt)
#section-title("04", "Cleanverse CVA record", "Live UAT issuance identifiers; independently rechecked by RWCAR")
#grid(
  columns: (1fr, 1fr),
  gutter: 9pt,
  field("Asset name", [RWCAR Receivable Note I]),
  field("Symbol / decimals", [RWRN01 / 6]),
  field("Network", [Monad Testnet · Chain ID 10143]),
  field("Cleanverse status", [ISSUED · Unpaused]),
)
#v(6pt)
#field("CVA contract", [0x7A33e03B10268FFdB50e562721B092BC0Cb793F9], mono: true)
#v(6pt)
#grid(
  columns: (1fr, 1fr),
  gutter: 9pt,
  field("Cleanverse launch request", [IA20260805120745190158], mono: true),
  field("Issuance flow", [LAUNCH]),
)
#v(6pt)
#field("Issuance transaction", [0xeb0adb893e98171fef8f67d118e8da3b0816dad03f7a1d016116273dbf13c785], mono: true)

#v(8pt)
#section-title("05", "RWCAR protocol anchors", "Deployed contracts used for the testnet repo lifecycle")
#grid(
  columns: (1fr, 1fr),
  gutter: 8pt,
  field("RepoMarketV1", [0x90535a7176a3b2c251c834b28e11e245622ee808], mono: true),
  field("CVA asset registry", [0x38a859695c32eea74b51c0f098039e15e616d5d6], mono: true),
)
#v(6pt)
#field("Cleanverse compliance validator", [0xaC7e5179C2C7f03f209136886c172eb34F161792], mono: true)

#v(8pt)
#section-title("06", "Valuation attestation", "The wallet signature is collected separately through the RWCAR backend")
#grid(
  columns: (1fr, 1fr),
  gutter: 9pt,
  field("Authorized UAT valuer", [0x911F99f4…f7252B02], mono: true),
  field("Validity", [30 days from signing]),
)
#v(6pt)
#block(width: 100%, fill: rgb("#ECFDF5"), stroke: 0.7pt + rgb("#6EE7B7"), radius: 5pt, inset: 8pt)[
  #text(size: 8.5pt, weight: "bold", fill: green)[OFF-CHAIN SIGNATURE RECORD]
  #v(3pt)
  #text(size: 8pt, fill: green)[RWCAR hashes this exact PDF and validates an EIP-712 signature from the authorized UAT valuation wallet. The signature record is stored separately; no private key is embedded in this document.]
]

#v(6pt)
#block(width: 100%, fill: white, stroke: 0.8pt + border, radius: 5pt, inset: 7pt)[
  #label([07 / Mandatory disclaimer]) #v(3pt)
  This record represents synthetic testnet data only. No named party owes money under it. It does not establish ownership of a real receivable, confer payment rights, solicit investment, or represent legal, accounting, tax, or financial advice. RWRN01 has no guaranteed value and must not be transferred or represented as a production asset. The record may be used solely to test RWCAR, Cleanverse UAT, and Monad Testnet integrations.
]
