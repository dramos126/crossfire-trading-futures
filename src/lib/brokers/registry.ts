import type { BrokerPlugin } from "@/lib/brokers/plugin";

export class BrokerRegistry {
  private plugins = new Map<string, BrokerPlugin>();

  register(plugin: BrokerPlugin): void {
    this.plugins.set(plugin.id, plugin);
  }

  getPlugin(id: string): BrokerPlugin | null {
    return this.plugins.get(id) ?? null;
  }

  allPlugins(): BrokerPlugin[] {
    return [...this.plugins.values()];
  }
}
