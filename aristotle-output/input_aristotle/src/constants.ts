export const CHAIN_ID = 4663n;
export const RPC_DEFAULT = "https://rpc.mainnet.chain.robinhood.com";
export const FACTORY = "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB";
export const LOCKER = "0x736D76699C26D0d966744cAe304C000d471f7F35";
export const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
export const V3_FACTORY = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA";
export const ROUTER = "0xCaf681a66D020601342297493863E78C959E5cb2";
export const QUOTER = "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7";
export const POSITION_MANAGER = "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3";
export const BURN = "0x000000000000000000000000000000000000dEaD";
export const Q192 = 1n << 192n;
export const BPS = 10_000n;
export const ABIS = {
  factory: [
    "function locker() view returns(address)",
    "function getLaunchedToken(address) view returns(tuple(address token,address deployer,address pairedToken,address positionManager,uint256 positionId,uint256 dexId,uint256 launchConfigId,uint256 restrictionsEndBlock,uint256 supply,bool isToken0,uint24 poolFee,bool exists,uint256 initialBuyAmount))",
  ],
  locker: [
    "function collectFees(address) returns(uint256,uint256)",
    "function feeRedirects(address) view returns(address)",
    "function tokenProtocolFeeShares(address) view returns(uint256)",
    "function protocolFeeRecipient() view returns(address)",
    "function feeCollectors(address) view returns(bool)",
    "event FeesClaimed(address indexed token,address indexed caller,address token0,address token1,uint256 recipientAmount0,uint256 recipientAmount1,uint256 protocolAmount0,uint256 protocolAmount1)",
  ],
  token: [
    "function name() view returns(string)",
    "function symbol() view returns(string)",
    "function decimals() view returns(uint8)",
    "function totalSupply() view returns(uint256)",
    "function balanceOf(address) view returns(uint256)",
    "function allowance(address,address) view returns(uint256)",
    "function approve(address,uint256) returns(bool)",
    "function transfer(address,uint256) returns(bool)",
    "function liquidityPool() view returns(address)",
    "function launchFactory() view returns(address)",
    "event Transfer(address indexed from,address indexed to,uint256 value)",
  ],
  v3factory: ["function getPool(address,address,uint24) view returns(address)"],
  pool: [
    "function token0() view returns(address)",
    "function token1() view returns(address)",
    "function liquidity() view returns(uint128)",
    "function tickSpacing() view returns(int24)",
    "function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)",
    "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)",
  ],
  quoter: [
    "function quoteExactInputSingle(tuple(address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
  ],
  router: [
    "function exactInputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns(uint256)",
  ],
  positionManager: [
    "function ownerOf(uint256) view returns(address)",
    "function positions(uint256) view returns(uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
    "function mint(tuple(address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns(uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
    "function transferFrom(address,address,uint256)",
    "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
    "event IncreaseLiquidity(uint256 indexed tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
  ],
};
