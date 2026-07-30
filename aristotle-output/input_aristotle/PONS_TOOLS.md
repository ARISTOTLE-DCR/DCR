# Neutral PONS and Robinhood Chain tool surface

These are factual platform capabilities and integration details. They do not
prescribe a mathematical model, objective, allocation, signal, or action.
Verify all identities and assumptions in the runtime before signing.

## Network

- Chain ID: `4663`
- Native gas asset: ETH
- Public RPC: `https://rpc.mainnet.chain.robinhood.com`
- Explorer: `https://robinhoodchain.blockscout.com`
- Blockscout API v2: `https://robinhoodchain.blockscout.com/api/v2`

## Active PONS and swap contracts

- PONS factory:
  `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB`
- Factory deployment/start block: `8,991,118`
- PONS locker:
  `0x736D76699C26D0d966744cAe304C000d471f7F35`
- WETH:
  `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`
- Uniswap V3 factory:
  `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA`
- Nonfungible position manager:
  `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3`
- SwapRouter02:
  `0xCaf681a66D020601342297493863E78C959E5cb2`
- Quoter V2:
  `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7`
- Conventional burn address:
  `0x000000000000000000000000000000000000dEaD`
- Current pool fee tier: `10000` (1%)

Current PONS tokens and WETH use 18 decimals. Creator fees are delivered as WETH
and the launched token. Native ETH is separately required for gas. Read the
per-token creator/protocol split from the locker rather than assuming it.

## Factory reads

```solidity
function locker() view returns (address);

function getLaunchedToken(address token) view returns (
  (
    address token,
    address deployer,
    address pairedToken,
    address positionManager,
    uint256 positionId,
    uint256 dexId,
    uint256 launchConfigId,
    uint256 restrictionsEndBlock,
    uint256 supply,
    bool isToken0,
    uint24 poolFee,
    bool exists,
    uint256 initialBuyAmount
  ) launched
);

function graduationStatus(address token) view returns (
  uint256 pairedPrincipal,
  uint256 threshold,
  bool graduated
);
```

## Creator-fee locker

```solidity
function collectFees(address token)
  returns (uint256 amount0, uint256 amount1);

function feeRedirects(address token) view returns (address recipient);
function tokenProtocolFeeShares(address token) view returns (uint256 share);
function protocolFeeRecipient() view returns (address);
function feeCollectors(address caller) view returns (bool);

event FeesClaimed(
  address indexed token,
  address indexed caller,
  address token0,
  address token1,
  uint256 recipientAmount0,
  uint256 recipientAmount1,
  uint256 protocolAmount0,
  uint256 protocolAmount1
);

error NoFeesToCollect();
error NotAuthorized();
error TokenNotFound();
```

The locker authorizes collection for the locker owner, launch deployer, resolved
fee recipient, or an enabled collector. Net creator fees go directly to the
resolved fee recipient. An enabled collector is not necessarily the recipient.
`NoFeesToCollect` is an ordinary state, not a fatal platform failure.

## Token and pool reads/actions

PONS tokens expose ordinary ERC-20 functionality plus:

```solidity
function name() view returns (string);
function symbol() view returns (string);
function decimals() view returns (uint8);
function totalSupply() view returns (uint256);
function balanceOf(address) view returns (uint256);
function allowance(address owner, address spender) view returns (uint256);
function approve(address spender, uint256 amount) returns (bool);
function transfer(address to, uint256 amount) returns (bool);
function liquidityPool() view returns (address);
function launchFactory() view returns (address);
```

The canonical V3 pool can be verified and inspected with:

```solidity
function getPool(address tokenA, address tokenB, uint24 fee)
  view returns (address pool);

function token0() view returns (address);
function token1() view returns (address);
function liquidity() view returns (uint128);
function slot0() view returns (
  uint160 sqrtPriceX96,
  int24 tick,
  uint16 observationIndex,
  uint16 observationCardinality,
  uint16 observationCardinalityNext,
  uint8 feeProtocol,
  bool unlocked
);
```

Standard ERC-20 `Transfer` logs can reconstruct holder balances from the
specific token's launch, subject to contract-address classification and reorg
handling. Standard V3 `Swap` logs expose individual swaps. The public RPC times
out on very wide `eth_getLogs` ranges, so observations must be obtainable with
bounded queries and must not require a full-chain scan before the first policy
cycle. Blockscout may be used as a cross-check, not blindly treated as complete
ground truth.

Event topics:

- ERC-20 `Transfer`:
  `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`
- V3 `Swap`:
  `0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67`
- PONS `TokenLaunched`:
  `0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a`

Pool price follows Uniswap V3 Q96 arithmetic. If the launched token is token0,
WETH per token is `(sqrtPriceX96 / 2^96)^2`; otherwise invert it. Asset
accounting should remain rational/integer rather than binary floating point.

## Buy and sell tools

Quoter V2:

```solidity
function quoteExactInputSingle(
  (
    address tokenIn,
    address tokenOut,
    uint256 amountIn,
    uint24 fee,
    uint160 sqrtPriceLimitX96
  ) params
) returns (
  uint256 amountOut,
  uint160 sqrtPriceX96After,
  uint32 initializedTicksCrossed,
  uint256 gasEstimate
);
```

SwapRouter02:

```solidity
function exactInputSingle(
  (
    address tokenIn,
    address tokenOut,
    uint24 fee,
    address recipient,
    uint256 amountIn,
    uint256 amountOutMinimum,
    uint160 sqrtPriceLimitX96
  ) params
) payable returns (uint256 amountOut);
```

This deployed router form has no deadline field. A swap can be protected with an
immediate quote, bounded slippage, preflight simulation, exact/temporary
approval, receipt confirmation, and actual balance-delta verification.

Buying is a WETH-to-token exact-input swap. Selling is a token-to-WETH
exact-input swap. Burning, if an independently derived theory chooses to use it,
is an ERC-20 transfer of the launched token to the conventional burn address.

## Public read-only integration fixture

This existing PONS launch can be used only to verify reads, pool discovery,
quotes, fee-claim simulation, and dry-run behavior. Never send transactions for
it:

- Token: `0x29b9e5306cbc8e0e8e4c1d63fc85a843303e0c7a`
- Expected launch deployer:
  `0xFe884239Ab22cA90BB86a33120aD932bd52339F1`
- Expected canonical pool:
  `0xB7a165b96D8f6dD131B2ea5B5Df7ad9E46507426`

No private key is supplied for this fixture.
