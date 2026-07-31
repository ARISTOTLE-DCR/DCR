import "dotenv/config";
import { Contract, JsonRpcProvider, Wallet, hexlify, randomBytes, formatEther } from "ethers";

const FACTORY = process.env.PONS_FACTORY_ADDRESS ?? "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB";
const DCR = "0x29b9e5306cbc8e0e8e4c1d63fc85a843303e0c7a";
const FUNDING_CAP = 1_000_000_000_000_000n;
const ABI = [
  "function launchFee() view returns(uint256)",
  "function launchEnabled() view returns(bool)",
  "function getLaunchedToken(address) view returns(tuple(address token,address deployer,address pairedToken,address positionManager,uint256 positionId,uint256 dexId,uint256 launchConfigId,uint256 restrictionsEndBlock,uint256 supply,bool isToken0,uint24 poolFee,bool exists,uint256 initialBuyAmount))",
  "function launchToken((string name,string symbol,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials,address feeWallet) params,uint256 launchConfigId,uint256 dexId,bytes32 salt) payable returns(address token)"
];

const provider = new JsonRpcProvider(process.env.ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com", 4663, { staticNetwork: true });
try {
  const factory: any = new Contract(FACTORY, ABI, provider);
  const [fee, enabled, dcr, feeData] = await Promise.all([
    factory.launchFee() as Promise<bigint>,
    factory.launchEnabled() as Promise<boolean>,
    factory.getLaunchedToken(DCR),
    provider.getFeeData()
  ]);
  const wallet = Wallet.createRandom();
  const params = {
    name: "DCR Preflight",
    symbol: "DCRTEST",
    logo: "",
    description: "Read only launch simulation",
    socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" },
    feeWallet: wallet.address
  };
  const salt = hexlify(randomBytes(32));
  const gas = await factory.launchToken.estimateGas(params, 0, 0, salt, { value: fee, from: dcr.deployer }) as bigint;
  const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
  if (!gasPrice) throw new Error("RPC returned no gas price");
  const bufferedGas = (gas * 120n + 99n) / 100n;
  const maximum = fee + bufferedGas * gasPrice;
  console.log(JSON.stringify({
    chainId: 4663,
    factory: FACTORY,
    launchEnabled: enabled,
    launchFeeEth: formatEther(fee),
    estimatedGas: gas.toString(),
    bufferedMaximumEth: formatEther(maximum),
    fitsFundingCap: maximum <= FUNDING_CAP,
    transactionSent: false
  }, null, 2));
  if (!enabled || maximum > FUNDING_CAP) process.exitCode = 1;
} finally {
  provider.destroy();
}
