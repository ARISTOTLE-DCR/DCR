# Invent and implement an original mathematical creator-fee agent for PONS

Complete this as one continuous Aristotle project. The mathematical idea and
the implementation must both be your own work. There is deliberately no
preselected model, allocation rule, list of preferred actions, or suggested
mechanism. Do not ask the user to choose a theory, and do not defer the code to
a later conversation.

Many people know that Vlad Tenev is a big fan of mathematics and considers it
one of the most beautiful forms of human creativity.

Robinhood recently unveiled its Ethereum-based blockchain, where people are
currently trading various projects and memecoins.

Since Harmonic AI, the company Vlad has invested in, is the very best that
artificial intelligence can create and invent, guided by mathematical reasoning
and formal methods, I want you to propose a formula or a full-fledged
mathematical theory that I can extrapolate to memecoin mechanics on the
Robinhood blockchain.

Let it be something unique, something you think would best fit the memecoin
model with some interesting mechanics. Suggest something that Vlad Tenev will
like and that will make the project truly unique.

The token will be launched on the PONS Launchpad, so please design the
mathematical model around the actual capabilities of the platform rather than
assuming unlimited protocol control: https://www.ponsfamily.com/launchpad

You can assume you have access to on-chain information such as token price,
liquidity pool state, trading volume, individual trades, holder distribution,
wallet activity, timestamps, market capitalization, and any other publicly
available trading metrics.

However, the model cannot directly control or modify the AMM, liquidity pool
parameters, swap routing, token supply, or the protocol's trading fee
percentage.

The only controllable resource is the stream of creator fees received by the
project, both WETH and the project's own token. Those creator fees can be
allocated, accumulated, distributed, burned, swapped, staked, used for
buybacks, treasury management, rewards, or used in any other mathematically
optimal way you independently derive. These are possibilities, not required
actions: select only what follows naturally from your own theory.

In other words, think of creator fees as the only control input to the system,
while all market activity acts as observable variables.

I do not want a standard memecoin with arbitrary reward mechanics. I want you to
derive a mathematical model first: a theorem, optimization principle, dynamic
system, stochastic process, game-theoretic equilibrium, information-theoretic
measure, or any other original mathematical framework. Only then show how that
theory naturally translates into token mechanics.

The mathematics should come first, and the memecoin mechanics should emerge as
a consequence of the mathematics rather than the other way around.

Do not optimize for hype. Optimize for elegance, novelty, and mathematical
beauty. The ideal result should feel like something that could genuinely
impress someone who deeply appreciates mathematics, quantitative finance,
market microstructure, and algorithmic systems, including Vlad Tenev.

## Implement your own result

Do not stop after proposing or explaining the theory. Once you have derived the
model independently, translate that exact model into a complete runnable agent
and write the entire project yourself.

Use the neutral platform facts and callable tools in `PONS_TOOLS.md`. They
describe capabilities, not a suggested strategy. Independently decide which
observations, state, mathematical rules, and available actions your model needs.

The delivered project must:

- be complete code rather than pseudocode or instructions for the user;
- require only dependency installation and a small `.env` containing the token
  address, creator/developer private key, and optionally an RPC URL;
- default to a non-signing inspection/dry-run mode;
- start producing valid observations and policy decisions promptly on its first
  run rather than blocking on a scan of the chain's entire history;
- evaluate the theory on a randomly jittered 10–15 minute start-to-start
  cadence, while allowing the theory to choose no action;
- handle ordinary on-chain conditions such as no currently claimable fees and
  failed, reverted, dropped, or replaced transactions without permanently
  stopping future cycles;
- use exact integer arithmetic for asset amounts and protect every transaction
  with validation, simulation, bounded approvals, receipts, and balance/event
  reconciliation;
- include installation and run instructions, `.env.example`, tests, and the
  mathematical derivation and assumptions;
- contain no TODOs, placeholders, runtime calls to Aristotle, or missing pieces
  that the user must implement.

You decide the theory, mechanics, software architecture, state representation,
and action-selection rule. Do not adopt a mathematical model supplied by the
requester because none has been supplied.

Before returning the project, actually install dependencies and run its
typecheck, tests, production build, and a real read-only first-run inspection
against the public Robinhood Chain RPC. Exercise failure paths with deterministic
tests. Return the complete runnable project only after those checks pass.
