import { asaasAdapter } from "./asaas.js";
import { mercadoPagoAdapter } from "./mercado-pago.js";
import { pagBankAdapter } from "./pagbank.js";
import { pixAdapter } from "./pix.js";
import { stripeAdapter } from "./stripe.js";
import type {
  ProviderAdapter,
  ProviderName,
  ProviderRouteName
} from "./types.js";
import { PROVIDERS } from "./types.js";

const adapters: ReadonlyMap<ProviderName, ProviderAdapter> = new Map(
  [asaasAdapter, pagBankAdapter, mercadoPagoAdapter, stripeAdapter, pixAdapter].map(
    (adapter) => [adapter.name, adapter]
  )
);

export function isProviderName(value: string): value is ProviderName {
  return (PROVIDERS as readonly string[]).includes(value);
}

export function normalizeProviderName(value: string): ProviderName | undefined {
  const canonical = value === "mercado-pago" ? "mercado_pago" : value;
  return isProviderName(canonical) ? canonical : undefined;
}

export function providerRouteName(provider: ProviderName): ProviderRouteName {
  return provider === "mercado_pago" ? "mercado-pago" : provider;
}

export function getProviderAdapter(
  providerInput: ProviderName | ProviderRouteName
): ProviderAdapter {
  const provider = normalizeProviderName(providerInput);
  const adapter = provider === undefined ? undefined : adapters.get(provider);
  if (adapter === undefined) {
    throw new Error(`provider adapter is not registered: ${providerInput}`);
  }
  return adapter;
}

export type {
  AuthenticationInput,
  AuthenticationResult,
  CanonicalEvent,
  HeaderBag,
  ProviderAdapter,
  ProviderName,
  ProviderRouteName,
  QueryBag
} from "./types.js";
export { ProviderRequestError } from "./types.js";
