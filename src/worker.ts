import { Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import axios from "axios";
import "dotenv/config";

/* =========================
   Tipos
========================= */

interface OrderItem {
  quantity: number;
  name: string;
  price: number;
  notes?: string | null;
  orderItemComplements: {
    quantity: number;
    name: string;
    price: number | null;
  }[];
}

interface OrderData {
  code: number;
  customerName: string;
  customerPhone: string;
  notes?: string | null;
  paymentMethod: string;
  change?: number | null;
  status: string;
  updatedAt: Date;
  deliveryMethodCode?: string | null;
  items: OrderItem[];
}

export interface OrderMessageJobData {
  type: "ORDER_CREATED" | "ORDER_STATUS_UPDATED";
  order: OrderData;
  sequence: number;
  evolutionInstance: string;
}

/* =========================
   Redis (CONEXÃO EXCLUSIVA)
========================= */

function createRedisConnection() {
  return new IORedis(process.env.REDIS_URL!, {
    maxRetriesPerRequest: null, // obrigatório para workers
    enableReadyCheck: true,
    keepAlive: 10000,
    retryStrategy(times) {
      return Math.min(times * 100, 2000);
    },
  });
}

const workerConnection = createRedisConnection();

/* =========================
   Helpers de negócio
========================= */

function calculateItemPrice(item: any): number {
  const pizzaFlavors = item.pizzaFlavors || item.orderItemPizzaFlavors;
  if (pizzaFlavors?.length) {
    const prices = pizzaFlavors.map((f: any) => f.price);
    const type = item.pizzaPricingType || item.pizzaConfig?.pricingType || "average";
    if (type === "sum") return prices.reduce((a: number, b: number) => a + b, 0);
    if (type === "max") return Math.max(...prices);
    return Math.round(prices.reduce((a: number, b: number) => a + b, 0) / prices.length);
  }
  return item.price ?? 0;
}

function calculateOrderTotal(order: OrderData): number {
  return order.items.reduce((acc, item: any) => {
    const itemPrice = calculateItemPrice(item);
    const complements = item.complements || item.orderItemComplements || [];
    const complementsTotal = complements.reduce(
      (sum: number, c: any) => sum + (c.price ?? 0) * c.quantity,
      0,
    );
    return acc + (itemPrice + complementsTotal) * item.quantity;
  }, 0);
}

function formatOrderMessage(
  order: OrderData,
  type: "ORDER_CREATED" | "ORDER_STATUS_UPDATED",
): string {
  if (type === "ORDER_STATUS_UPDATED") {
    if (order.status === "in_preparation") {
      return "Agora vai! Seu pedido já está *em produção* 🥳";
    }
    if (order.status === "completed") {
      return "Tô chegando! Seu pedido já está na rota de *entrega* 🛵";
    }
    return "";
  }

  const total = calculateOrderTotal(order);
  const totalFormatted = (total / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });

  let msg = `Pedido *n° ${order.code}*\n\n*Itens:*\n`;

  for (const item of order.items) {
    const q = item.quantity > 1 ? `${item.quantity}x ` : "";
    msg += `📦 \`\`\`${q}${item.name}\`\`\`\n`;

    if (item.notes) msg += `*OBS:* ${item.notes}\n`;
    msg += "\n";
  }

  msg += `Total *${totalFormatted}*\n\nObrigado pela preferência! 😉`;
  return msg;
}

async function sendMessage(message: string, customerPhone: string, evolutionInstance: string) {
  await axios.post(
    `${process.env.EVOLUTION_API_URL}/message/sendText/${evolutionInstance}`,
    { number: customerPhone, text: message },
    {
      headers: {
        apikey: process.env.EVOLUTION_API_KEY!,
        "Content-Type": "application/json",
      },
    },
  );
}

function isTemporaryProviderError(err: any): boolean {
  if (!err) return false;
  if (["ECONNRESET", "ETIMEDOUT", "EPIPE"].includes(err.code)) return true;
  if (err.response?.status >= 500) return true;
  return false;
}

/* =========================
   Processor
========================= */

async function processOrderMessage(job: Job<OrderMessageJobData>) {
  const { order, type, evolutionInstance } = job.data;

  await job.log(`Processando pedido ${order.code} (${type})`);

  const message = formatOrderMessage(order, type);

  try {
    await sendMessage(message, order.customerPhone, evolutionInstance);
    await job.log(`Mensagem enviada para ${order.customerPhone}`);
  } catch (err: any) {
    if (isTemporaryProviderError(err)) {
      throw err; // retry automático
    }
    throw new Error(`Falha permanente ao enviar mensagem: ${err.message}`);
  }
}

/* =========================
   Worker
========================= */

export const messageWorker = new Worker<OrderMessageJobData>(
  "message-processing",
  processOrderMessage,
  {
    connection: workerConnection,
    concurrency: 1,
    lockDuration: 60000,
    maxStalledCount: 2,
  },
);

/* =========================
   Eventos
========================= */

messageWorker.on("completed", (job) => {
  console.log(`✅ Job ${job.id} concluído`);
});

messageWorker.on("failed", (job, err) => {
  console.error(`❌ Job ${job?.id} falhou:`, err.message);
});

messageWorker.on("error", (err) => {
  console.error("🔥 Erro no worker:", err);
});

/* =========================
   Graceful shutdown
========================= */

async function shutdown() {
  console.log("Encerrando worker...");
  await messageWorker.close();
  await workerConnection.quit();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
