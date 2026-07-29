export const CHAIN_ID = 4663n;
export const RPC_DEFAULT = "https://rpc.mainnet.chain.robinhood.com";
export const FACTORY = "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB";
export const LOCKER = "0x736D76699C26D0d966744cAe304C000d471f7F35";
export const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
export const V3_FACTORY = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA";
export const ROUTER = "0xCaf681a66D020601342297493863E78C959E5cb2";
export const QUOTER = "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7";
export const BURN = "0x000000000000000000000000000000000000dEaD";
export const PUBLIC_FIXTURE = "0xbe284496abf795cb2ee007e947212343a7cf3c65";
export const EXPECTED_FIXTURE_POOL = "0xB7a165b96D8f6dD131B2ea5B5Df7ad9E46507426";
export const Q192 = 1n << 192n;
export const BPS = 10_000n;
export const ABIS = {
 factory: ["function locker() view returns(address)","function getLaunchedToken(address) view returns(tuple(address token,address deployer,address pairedToken,address positionManager,uint256 positionId,uint256 dexId,uint256 launchConfigId,uint256 restrictionsEndBlock,uint256 supply,bool isToken0,uint24 poolFee,bool exists,uint256 initialBuyAmount))"],
 locker: ["function collectFees(address) returns(uint256,uint256)","function feeRedirects(address) view returns(address)","function tokenProtocolFeeShares(address) view returns(uint256)","function protocolFeeRecipient() view returns(address)","function feeCollectors(address) view returns(bool)","event FeesClaimed(address indexed token,address indexed caller,address token0,address token1,uint256 recipientAmount0,uint256 recipientAmount1,uint256 protocolAmount0,uint256 protocolAmount1)"],
 token: ["function name() view returns(string)","function symbol() view returns(string)","function decimals() view returns(uint8)","function totalSupply() view returns(uint256)","function balanceOf(address) view returns(uint256)","function allowance(address,address) view returns(uint256)","function approve(address,uint256) returns(bool)","function transfer(address,uint256) returns(bool)","function liquidityPool() view returns(address)","function launchFactory() view returns(address)"],
 v3factory: ["function getPool(address,address,uint24) view returns(address)"],
 pool: ["function token0() view returns(address)","function token1() view returns(address)","function liquidity() view returns(uint128)","function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)","event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)"],
 quoter: ["function quoteExactInputSingle(tuple(address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)"],
 router: ["function exactInputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns(uint256)"],
};
