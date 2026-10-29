import { BrokerRegistry } from "@/lib/brokers/registry";
import { TopstepBrokerPlugin } from "@/lib/brokers/topstep/index";
import { TradovateBrokerPlugin } from "@/lib/brokers/tradovate/index";

export const brokerRegistry = new BrokerRegistry();
brokerRegistry.register(new TopstepBrokerPlugin());
brokerRegistry.register(new TradovateBrokerPlugin());
