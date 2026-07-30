# Verified permanent-liquidity tool surface

These are neutral deployed-contract facts and execution requirements. They do
not prescribe a tick range, allocation, signal, or mathematical policy.

## Canonical contracts

- Chain ID: `4663`
- WETH: `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`
- V3 factory: `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA`
- NonfungiblePositionManager:
  `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3`
- Conventional burn address:
  `0x000000000000000000000000000000000000dEaD`
- Current PONS pool fee tier: `10000`

The position manager is verified on Robinhood Chain as
`NonfungiblePositionManager`, compiler `v0.7.6+commit.7338295f`. Runtime must
still compare the launch's `positionManager`, canonical V3 factory, token pair,
pool, and fee tier against on-chain metadata before signing.

## Required reads

```solidity
function ownerOf(uint256 tokenId) view returns (address);

function positions(uint256 tokenId) view returns (
  uint96 nonce,
  address operator,
  address token0,
  address token1,
  uint24 fee,
  int24 tickLower,
  int24 tickUpper,
  uint128 liquidity,
  uint256 feeGrowthInside0LastX128,
  uint256 feeGrowthInside1LastX128,
  uint128 tokensOwed0,
  uint128 tokensOwed1
);

function tickSpacing() view returns (int24);
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

## Mint and irreversible transfer

```solidity
function mint(
  (
    address token0,
    address token1,
    uint24 fee,
    int24 tickLower,
    int24 tickUpper,
    uint256 amount0Desired,
    uint256 amount1Desired,
    uint256 amount0Min,
    uint256 amount1Min,
    address recipient,
    uint256 deadline
  ) params
) payable returns (
  uint256 tokenId,
  uint128 liquidity,
  uint256 amount0,
  uint256 amount1
);

function transferFrom(address from, address to, uint256 tokenId);

event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
event IncreaseLiquidity(
  uint256 indexed tokenId,
  uint128 liquidity,
  uint256 amount0,
  uint256 amount1
);
```

Use `transferFrom`, not `safeTransferFrom`, when transferring to the conventional
burn address because that address does not implement `IERC721Receiver`.

The position manager's ERC-721 `burn(tokenId)` function cannot destroy a
position that still contains liquidity or owed tokens. Permanent locking here
means transferring ownership of the live NFT position to the conventional burn
address and confirming the new owner on-chain.

The original PONS launch position is owned/managed by the PONS locker and must
never be modified. Every strategy LP action creates a separate new NFT.
