import type { DashboardPayload } from "./types";

const baseJobs: DashboardPayload["jobs"] = [
  {
    id: "01JZ7V2XE4F5ZTF02YN9K4P1A7",
    tenant: "Aithos Pay",
    tenantId: "tnt_aithos_pay",
    type: "deliver_event",
    source: "Asaas · Cobranças",
    status: "completed",
    attempts: 1,
    maxAttempts: 8,
    priority: "high",
    availableAt: "agora",
    createdAt: "26 jul 2026, 15:42:18",
    duration: "128ms",
    externalEventId: "evt_0b82fe7c",
    payloadPreview: {
      event: "PAYMENT_RECEIVED",
      payment: { id: "pay_***82fe", value: 18990 },
      customer: "[redacted]"
    }
  },
  {
    id: "01JZ7V1PM3TNBWG4QJS3W7R2E9",
    tenant: "Nexo Finance",
    tenantId: "tnt_nexo",
    type: "deliver_event",
    source: "Mercado Pago · Checkout",
    status: "processing",
    attempts: 2,
    maxAttempts: 8,
    priority: "high",
    availableAt: "agora",
    createdAt: "26 jul 2026, 15:41:52",
    duration: "3.2s",
    externalEventId: "123456789012",
    payloadPreview: {
      action: "payment.updated",
      data: { id: "1234***9012" },
      live_mode: true
    }
  },
  {
    id: "01JZ7TZ9R7MFPX6CAK8E1B3D5V",
    tenant: "Vértice",
    tenantId: "tnt_vertice",
    type: "deliver_event",
    source: "Pix · Antifraude",
    status: "pending",
    attempts: 0,
    maxAttempts: 8,
    priority: "medium",
    availableAt: "em 18s",
    createdAt: "26 jul 2026, 15:41:31",
    duration: "—",
    externalEventId: "E1823612***05145",
    payloadPreview: {
      tipo: "pix.recebido",
      endToEndId: "E182***145",
      valor: 420.5
    }
  },
  {
    id: "01JZ7TY4H8QK2N5PVW6F0C3M9S",
    tenant: "Lumina Capital",
    tenantId: "tnt_lumina",
    type: "reconcile_psp",
    source: "PagBank · Pedidos",
    status: "retry",
    attempts: 4,
    maxAttempts: 8,
    priority: "medium",
    availableAt: "em 2m 14s",
    createdAt: "26 jul 2026, 15:38:05",
    duration: "2.8s",
    externalEventId: "recon_20260726_15",
    payloadPreview: {
      provider: "pagbank",
      windowStart: "2026-07-26T14:00:00Z",
      windowEnd: "2026-07-26T15:00:00Z"
    }
  },
  {
    id: "01JZ7TW0D2L8YF6R9K4A3Q5C7X",
    tenant: "Aithos Pay",
    tenantId: "tnt_aithos_pay",
    type: "deliver_event",
    source: "Stripe · Billing",
    status: "dead-letter",
    attempts: 8,
    maxAttempts: 8,
    priority: "high",
    availableAt: "esgotado",
    createdAt: "26 jul 2026, 15:31:44",
    duration: "30.0s",
    externalEventId: "evt_1Pz***3Nd",
    payloadPreview: {
      type: "invoice.payment_failed",
      id: "evt_***3Nd",
      livemode: true
    }
  },
  {
    id: "01JZ7TV5E1N3B8K6M9Q2R4F0P7",
    tenant: "Nexo Finance",
    tenantId: "tnt_nexo",
    type: "deliver_event",
    source: "Asaas · Assinaturas",
    status: "completed",
    attempts: 1,
    maxAttempts: 8,
    priority: "low",
    availableAt: "concluído",
    createdAt: "26 jul 2026, 15:29:17",
    duration: "94ms",
    externalEventId: "evt_2ca1af9d",
    payloadPreview: {
      event: "SUBSCRIPTION_UPDATED",
      subscription: { id: "sub_***af9d" }
    }
  }
];

export const demoDashboard: DashboardPayload = {
  generatedAt: "2026-07-26T18:42:30.000Z",
  tenant: {
    id: "all",
    name: "Todos os tenants",
    retentionDays: 90
  },
  stats: [
    {
      label: "Eventos processados",
      value: "24,8M",
      trend: "+18,2%",
      trendDirection: "up",
      hint: "vs. 24h anteriores"
    },
    {
      label: "Jobs concluídos",
      value: "1,2M",
      trend: "+12,4%",
      trendDirection: "up",
      hint: "vs. 24h anteriores"
    },
    {
      label: "Taxa de sucesso",
      value: "99,94%",
      trend: "+0,31%",
      trendDirection: "up",
      hint: "efeito idempotente"
    },
    {
      label: "Latência p95",
      value: "320ms",
      trend: "-8,0%",
      trendDirection: "up",
      hint: "ingestão → conclusão"
    }
  ],
  chart: [
    42, 48, 55, 51, 63, 69, 61, 58, 74, 82, 77, 92, 88, 104, 96, 110, 119,
    107, 126, 135, 123, 142, 151, 144, 162, 171, 156, 184, 177, 193
  ],
  activity: [
    {
      id: "act_1",
      title: "Cobranças → ERP financeiro",
      detail: "job 01JZ7V2XE4 · 128ms",
      time: "agora",
      tone: "success"
    },
    {
      id: "act_2",
      title: "PIX → Antifraude",
      detail: "job 01JZ7TZ9R7 · aguardando worker",
      time: "18s",
      tone: "warning"
    },
    {
      id: "act_3",
      title: "Stripe Billing → Data Lake",
      detail: "dead-letter · notificação enviada",
      time: "2m",
      tone: "danger"
    },
    {
      id: "act_4",
      title: "Reconciliação Mercado Pago",
      detail: "janela 14:00–15:00 · sem divergências",
      time: "7m",
      tone: "success"
    },
    {
      id: "act_5",
      title: "Purge LGPD concluído",
      detail: "1.842 payloads expirados",
      time: "12m",
      tone: "success"
    }
  ],
  jobs: baseJobs,
  events: [
    {
      id: "evt_int_01JZ7V2T",
      externalId: "evt_0b82fe7c",
      provider: "asaas",
      source: "Asaas · Cobranças",
      tenant: "Aithos Pay",
      eventType: "PAYMENT_RECEIVED",
      status: "accepted",
      receivedAt: "15:42:18.092",
      size: "4,8 KB",
      purgeAt: "24 out 2026"
    },
    {
      id: "evt_int_01JZ7V1H",
      externalId: "123456789012",
      provider: "mercado-pago",
      source: "Mercado Pago · Checkout",
      tenant: "Nexo Finance",
      eventType: "payment.updated",
      status: "accepted",
      receivedAt: "15:41:52.441",
      size: "2,1 KB",
      purgeAt: "24 out 2026"
    },
    {
      id: "evt_int_01JZ7V0C",
      externalId: "evt_0b82fe7c",
      provider: "asaas",
      source: "Asaas · Cobranças",
      tenant: "Aithos Pay",
      eventType: "PAYMENT_RECEIVED",
      status: "duplicate",
      receivedAt: "15:41:48.612",
      size: "4,8 KB",
      purgeAt: "24 out 2026"
    },
    {
      id: "evt_int_01JZ7TZ3",
      externalId: "E1823612***05145",
      provider: "pix",
      source: "Pix · Antifraude",
      tenant: "Vértice",
      eventType: "pix.recebido",
      status: "accepted",
      receivedAt: "15:41:31.029",
      size: "3,3 KB",
      purgeAt: "24 out 2026"
    },
    {
      id: "evt_int_01JZ7TY0",
      externalId: "evt_mismatch_71",
      provider: "stripe",
      source: "Stripe · Billing",
      tenant: "Lumina Capital",
      eventType: "invoice.updated",
      status: "quarantined",
      receivedAt: "15:38:05.501",
      size: "8,9 KB",
      purgeAt: "24 out 2026"
    }
  ],
  sources: [
    {
      id: "src_asaas_charge",
      name: "Asaas · Cobranças",
      provider: "asaas",
      description: "Cobranças, assinaturas e alterações de pagamento.",
      endpointKey: "whk_asa_••••••7q",
      status: "active",
      events24h: "487,2K",
      successRate: "99,98%"
    },
    {
      id: "src_mp_checkout",
      name: "Mercado Pago · Checkout",
      provider: "mercado-pago",
      description: "Atualizações de pagamento do Checkout Pro.",
      endpointKey: "whk_mpa_••••••2n",
      status: "active",
      events24h: "321,8K",
      successRate: "99,91%"
    },
    {
      id: "src_pagbank_order",
      name: "PagBank · Pedidos",
      provider: "pagbank",
      description: "Pedidos, cobranças e eventos pós-transacionais.",
      endpointKey: "whk_pgb_••••••4m",
      status: "active",
      events24h: "218,4K",
      successRate: "99,89%"
    },
    {
      id: "src_pix_fraud",
      name: "Pix · Antifraude",
      provider: "pix",
      description: "Adaptador Pix configurado com assinatura HMAC.",
      endpointKey: "whk_pix_••••••9x",
      status: "active",
      events24h: "163,1K",
      successRate: "99,97%"
    },
    {
      id: "src_stripe_bill",
      name: "Stripe · Billing",
      provider: "stripe",
      description: "Faturas, assinaturas e pagamentos internacionais.",
      endpointKey: "whk_stp_••••••3d",
      status: "inactive",
      events24h: "11,9K",
      successRate: "98,72%"
    }
  ],
  destinations: [
    {
      id: "dst_erp",
      name: "ERP financeiro",
      kind: "webhook",
      description: "Entrega eventos normalizados ao ERP principal.",
      host: "events.erp.example",
      status: "active",
      deliveries24h: "488K",
      latency: "84ms"
    },
    {
      id: "dst_lake",
      name: "Data Lake",
      kind: "data-lake",
      description: "Pipeline de eventos para análise e conciliação.",
      host: "ingest.lake.example",
      status: "active",
      deliveries24h: "772K",
      latency: "142ms"
    },
    {
      id: "dst_fraud",
      name: "Motor antifraude",
      kind: "internal",
      description: "Avaliação em tempo próximo do real para transações Pix.",
      host: "fraud.internal.example",
      status: "active",
      deliveries24h: "163K",
      latency: "61ms"
    }
  ],
  pipelines: [
    {
      id: "pipe_charges_erp",
      name: "Cobranças → ERP",
      source: "Asaas · Cobranças",
      destination: "ERP financeiro",
      description: "Normaliza pagamentos e mantém o razão sincronizado.",
      status: "active",
      throughput: "5,6K/min",
      successRate: "99,98%"
    },
    {
      id: "pipe_checkout_lake",
      name: "Checkout → Data Lake",
      source: "Mercado Pago · Checkout",
      destination: "Data Lake",
      description: "Histórico operacional para métricas e reconciliação.",
      status: "active",
      throughput: "3,9K/min",
      successRate: "99,91%"
    },
    {
      id: "pipe_pix_fraud",
      name: "Pix → Antifraude",
      source: "Pix · Antifraude",
      destination: "Motor antifraude",
      description: "Encaminha eventos Pix assinados com baixa latência.",
      status: "active",
      throughput: "2,8K/min",
      successRate: "99,97%"
    },
    {
      id: "pipe_stripe_lake",
      name: "Stripe → Data Lake",
      source: "Stripe · Billing",
      destination: "Data Lake",
      description: "Pipeline pausado enquanto a credencial é rotacionada.",
      status: "paused",
      throughput: "0/min",
      successRate: "98,72%"
    }
  ],
  workers: [
    {
      id: "wrk-sp-01-a8f3",
      region: "sa-east · node-01",
      status: "active",
      currentJobs: 11,
      capacity: 32,
      processed: "382K",
      uptime: "17d 08h",
      cpu: 34
    },
    {
      id: "wrk-sp-02-b4e9",
      region: "sa-east · node-02",
      status: "active",
      currentJobs: 24,
      capacity: 32,
      processed: "416K",
      uptime: "17d 08h",
      cpu: 71
    },
    {
      id: "wrk-sp-03-c2d1",
      region: "sa-east · node-03",
      status: "active",
      currentJobs: 8,
      capacity: 32,
      processed: "397K",
      uptime: "12d 14h",
      cpu: 28
    }
  ],
  tenants: [
    {
      id: "tnt_aithos_pay",
      name: "Aithos Pay",
      slug: "aithos-pay",
      plan: "Scale",
      status: "active",
      retentionDays: 90,
      eventsMonth: "8,2M",
      members: 7
    },
    {
      id: "tnt_nexo",
      name: "Nexo Finance",
      slug: "nexo-finance",
      plan: "Growth",
      status: "active",
      retentionDays: 60,
      eventsMonth: "4,7M",
      members: 4
    },
    {
      id: "tnt_vertice",
      name: "Vértice",
      slug: "vertice",
      plan: "Growth",
      status: "active",
      retentionDays: 45,
      eventsMonth: "3,1M",
      members: 3
    },
    {
      id: "tnt_lumina",
      name: "Lumina Capital",
      slug: "lumina-capital",
      plan: "Starter",
      status: "inactive",
      retentionDays: 30,
      eventsMonth: "611K",
      members: 2
    }
  ]
};
