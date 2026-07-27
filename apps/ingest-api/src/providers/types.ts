// These values intentionally match webhook_sources.provider in the database.
// URL aliases are normalized at the HTTP boundary and are never persisted.
export const PROVIDERS = ["asaas", "pagbank", "mercado_pago", "stripe", "pix"] as const;
export type ProviderName = (typeof PROVIDERS)[number];
export type ProviderRouteName = ProviderName | "mercado-pago";

export type HeaderBag = Readonly<Record<string, string | string[] | undefined>>;
export type QueryBag = Readonly<Record<string, string | string[] | undefined>>;

export interface AuthenticationInput {
  readonly rawBody: Buffer;
  readonly headers: HeaderBag;
  readonly query: QueryBag;
  readonly secret: Buffer;
  readonly providerConfig: unknown;
  readonly toleranceSeconds: number;
  readonly nowSeconds?: number;
}

export interface AuthenticationResult {
  readonly timestamp?: number;
  readonly requestId?: string;
}

export interface CanonicalEvent {
  readonly externalEventId: string;
  readonly eventType: string;
  readonly occurredAt: Date | undefined;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ProviderAdapter {
  readonly name: ProviderName;
  authenticate(input: AuthenticationInput): AuthenticationResult;
  parse(rawBody: Buffer, query: QueryBag, providerConfig: unknown): CanonicalEvent;
}

export class ProviderRequestError extends Error {
  public constructor(
    public readonly kind: "authentication" | "replay" | "schema",
    message: string
  ) {
    super(message);
    this.name = "ProviderRequestError";
  }
}
