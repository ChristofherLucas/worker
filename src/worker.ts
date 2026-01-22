import { Worker, type Job } from "bullmq";
import "dotenv/config";
import axios from "axios";

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
  updatedAt: string | Date;
  deliveryMethodCode?: string | null;
  items: OrderItem[];
}

export interface OrderMessageJobData {
  type: "ORDER_CREATED" | "ORDER_STATUS_UPDATED";
  order: OrderData;
  sequence: number;
  evolutionInstance: string;
}

const connection = {
  host: process.env.REDIS_HOST!,
  port: Number(process.env.REDIS_PORT!),
  password: process.env.REDIS_PASSWORD!,
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  keepAlive: 30000,
};

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
  return order.items.reduce((acc: number, item: any) => {
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
  const total = calculateOrderTotal(order);
  const totalFormatted = (total / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });

  if (type === "ORDER_STATUS_UPDATED") {
    if (order.status === "in_preparation") {
      return "Agora vai! Seu pedido já está *em produção* 🥳";
    }
    if (order.status === "completed") {
      return "Tô chegando! Seu pedido já está na rota de *entrega* 🛵";
    }
    return "";
  }

  let message = `Pedido *n° ${order.code}*\n\n*Itens:*\n`;

  for (const item of order.items) {
    const qty = item.quantity > 1 ? `${item.quantity}x ` : "";
    message += `📦 \`\`\`${qty}${item.name}\`\`\`\n`;

    const flavors = (item as any).pizzaFlavors || (item as any).orderItemPizzaFlavors;
    if (flavors?.length) {
      message += "     _Sabores_\n";
      const fraction = `1/${flavors.length}`;
      for (const f of flavors) {
        message += `           \`\`\`${fraction} ${f.name}\`\`\`\n`;
      }
    }

    if (item.orderItemComplements?.length) {
      message += "     _Complementos_\n";
      for (const c of item.orderItemComplements) {
        const cQty = c.quantity > 1 ? `${c.quantity}x ` : "";
        message += `           \`\`\`${cQty}${c.name}\`\`\`\n`;
      }
    }

    if (item.notes) {
      message += `\n*OBS:* ${item.notes}\n`;
    }

    message += "\n";
  }

  if (order.notes) {
    message += `*OBS:* ${order.notes}\n\n`;
  }

  message += `Total *${totalFormatted}*\n\nObrigado pela preferência! 😉`;

  return message;
}

async function sendMessage(
  message: string,
  customerPhone: string,
  evolutionInstance: string,
): Promise<void> {
  try {
    await axios.post(
      `${process.env.EVOLUTION_API_URL}/message/sendText/${evolutionInstance}`,
      { number: customerPhone, text: message },
      {
        headers: {
          "Content-Type": "application/json",
          apikey: process.env.EVOLUTION_API_KEY!,
        },
      },
    );
  } catch (error: any) {
    const err = new Error(`Failed to send message`) as any;
    err.status = error.response?.status;
    err.original = error;
    throw err;
  }
}

function isTemporaryProviderError(error: any): boolean {
  const status = error.status ?? error.response?.status;
  if (status && status >= 500) return true;

  return (
    ["ECONNRESET", "ETIMEDOUT"].includes(error.code) ||
    /timeout|network|temporarily/i.test(error.message ?? "")
  );
}

async function processOrderMessage(job: Job<OrderMessageJobData>): Promise<void> {
  const { order, type, evolutionInstance } = job.data;

  await job.log(`Processing order ${order.code} (${type})`);

  const message = formatOrderMessage(order, type);

  let instanceState: any;
  try {
    const res = await axios.get(
      `${process.env.EVOLUTION_API_URL}/instance/connectionState/${evolutionInstance}`,
      { headers: { apikey: process.env.EVOLUTION_API_KEY! } },
    );
    instanceState = res.data;
  } catch (error: any) {
    const status = error.response?.status;
    if (status === 404) {
      throw Object.assign(new Error("Evolution instance not found"), { status: 404 });
    }
    throw error;
  }

  if (instanceState?.instance?.state !== "open") {
    const err = new Error("Evolution instance not ready") as any;
    err.status = 503;
    throw err;
  }

  try {
    await sendMessage(message, order.customerPhone, evolutionInstance);
    await job.log(`Message sent successfully`);
  } catch (err: any) {
    if (err.status === 404) {
      throw err;
    }
    if (isTemporaryProviderError(err)) {
      throw err;
    }
    throw err;
  }
}

export const worker = new Worker("message-processing", processOrderMessage, {
  connection,
  concurrency: 1,
  lockDuration: 60000,
  stalledInterval: 30000,
  maxStalledCount: 2,
});

worker.on("completed", (job) => {
  console.log(`Job ${job?.id} completed`);
});

worker.on("failed", (job, err) => {
  console.error(`Job ${job?.id} failed:`, err.message);
});

worker.on("error", (err) => {
  console.error("Worker error:", err);
});
