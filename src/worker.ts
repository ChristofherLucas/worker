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
  if (pizzaFlavors && pizzaFlavors.length > 0) {
    const flavorPrices = pizzaFlavors.map((f: any) => f.price);
    const pricingType = item.pizzaPricingType || item.pizzaConfig?.pricingType || "average";

    if (pricingType === "sum") {
      return flavorPrices.reduce((sum: number, price: number) => sum + price, 0);
    } else if (pricingType === "average") {
      return Math.round(
        flavorPrices.reduce((sum: number, price: number) => sum + price, 0) / flavorPrices.length,
      );
    } else if (pricingType === "max") {
      return Math.max(...flavorPrices);
    }
  }
  return item.price ?? 0;
}

// Calcula o total do pedido, incluindo complementos
function calculateOrderTotal(order: OrderData): number {
  return order.items.reduce((acc: number, item: any) => {
    // Preço do item (considerando sabores de pizza e regra de precificação)
    const itemPrice = calculateItemPrice(item);
    // Complementos: suporta tanto orderItemComplements (backend) quanto complements (frontend)
    let complementsTotal = 0;
    const complements = item.complements || item.orderItemComplements;
    if (complements && Array.isArray(complements)) {
      complementsTotal += complements.reduce(
        (compAcc: number, comp: any) => compAcc + (comp.price ?? 0) * comp.quantity,
        0,
      );
    }
    // O valor total do item é (preço do item + total dos complementos) * quantidade
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

  let message = "";

  if (type === "ORDER_CREATED") {
    message = `Pedido *n° ${order.code}*

*Itens:*
`;

    for (const item of order.items) {
      const itemQuantity = item.quantity > 1 ? `${item.quantity}x ` : "";
      message += `📦 \`\`\`${itemQuantity}${item.name}\`\`\``;

      // Sabores de pizza (pizzaFlavors ou orderItemPizzaFlavors)
      const pizzaFlavors = (item as any)["pizzaFlavors"] || (item as any)["orderItemPizzaFlavors"];
      if (pizzaFlavors && pizzaFlavors.length > 0) {
        message += "\n     _Sabores_";
        const fraction = `1/${pizzaFlavors.length}`;
        for (const flavor of pizzaFlavors) {
          message += `\n           \`\`\`${fraction} ${flavor.name}\`\`\``;
        }
      }

      if (item.orderItemComplements && item.orderItemComplements.length > 0) {
        message += "\n     _Complementos_";
        for (const complement of item.orderItemComplements) {
          const complementQuantity = complement.quantity > 1 ? `${complement.quantity}x ` : "";
          message += `\n           \`\`\`${complementQuantity}${complement.name}\`\`\``;
        }
      }

      if (item.notes) {
        message += `\n\n*OBS:* ${item.notes}\n`;
      }
      message += "\n";
    }

    if (order.notes) {
      message += `\n*OBS:* ${order.notes}`;
    }

    message += `${order.notes ? "\n" : ""}\n${
      order.paymentMethod === "cash" || order.paymentMethod === "pix" ? "💵" : "💳"
    } ${
      order.paymentMethod === "cash"
        ? order.change
          ? `*Dinheiro (troco para ${(order.change / 100).toLocaleString("pt-BR", {
              style: "currency",
              currency: "BRL",
            })})*`
          : "*Dinheiro (não precisa de troco)*"
        : order.paymentMethod === "pix"
          ? "*Pix*"
          : "*Cartão*"
    }
🛵 ${
      order.deliveryMethodCode === "delivery"
        ? "*Delivery*"
        : order.deliveryMethodCode === "pickup"
          ? "*Retirada no local*"
          : "*Consumo no local*"
    }

Total *${totalFormatted}*

Obrigado pela preferência, se precisar de algo é só chamar! 😉`;
  } else if (type === "ORDER_STATUS_UPDATED") {
    if (order.status === "in_preparation") {
      message = "Agora vai! Seu pedido já está *em produção* 🥳";
    } else if (order.status === "completed") {
      message = "Tô chegando! Seu pedido já está na rota de *entrega* 🛵";
    }
  }

  return message;
}

async function sendMessage(
  message: string,
  customerPhone: string,
  evolutionInstance: string,
): Promise<void> {
  const evolutionConfig = {
    serverUrl: process.env.EVOLUTION_API_URL!,
    apiKey: process.env.EVOLUTION_API_KEY!,
    instance: evolutionInstance,
  };

  try {
    await axios.post(
      `${evolutionConfig.serverUrl}/message/sendText/${evolutionConfig.instance}`,
      {
        number: customerPhone,
        text: message,
      },
      {
        headers: {
          "Content-Type": "application/json",
          apikey: evolutionConfig.apiKey,
        },
      },
    );
  } catch (error: any) {
    const status = error.response?.status;
    const err = new Error(`Failed to send message: ${error.message}`) as any;

    err.status = status;

    throw err;
  }
}

function isTemporaryProviderError(error: any): boolean {
  if (!error) return false;
  if (error.name === "FetchError" || error.code === "ECONNRESET" || error.code === "ETIMEDOUT") {
    return true;
  }
  const status = error.status ?? error.response?.status;
  if (typeof status === "number" && status >= 500) {
    return true;
  }
  if (typeof error.message === "string") {
    const msg = error.message.toLowerCase();
    if (
      msg.includes("timeout") ||
      msg.includes("temporarily unavailable") ||
      msg.includes("network")
    ) {
      return true;
    }
  }
  return false;
}

async function processOrderMessage(job: Job<OrderMessageJobData>): Promise<void> {
  const { order, type, evolutionInstance } = job.data;

  await job.log(
    `Starting processing for order ${order.code} of type ${type} and sequence ${job.data.sequence}`,
  );

  const message = formatOrderMessage(order, type);

  let data;
  try {
    const response = await axios.get(
      `${process.env.EVOLUTION_API_URL}/instance/connectionState/${evolutionInstance}`,
      {
        headers: {
          apikey: process.env.EVOLUTION_API_KEY!,
        },
      },
    );
    data = response.data;
  } catch (error: any) {
    const status = error.response?.status;
    if (status === 404) {
      await job.log(
        `Evolution instance ${evolutionInstance} not found, delaying job (order ${order.code}).`,
      );
      return;
    }

    throw error;
  }

  if (!data?.instance.state || data.instance.state !== "open") {
    await job.log(
      `Evolution instance ${evolutionInstance} not ready, delaying job (order ${order.code}).`,
    );

    const err = new Error("Evolution instance not ready") as any;
    err.status = 503;
    throw err;
  }

  try {
    await sendMessage(message, order.customerPhone, evolutionInstance);
    await job.log(`Message sent successfully for order ${order.code}`);
  } catch (err: any) {
    const status = err.response?.status;
    if (status === 404) {
      await job.log(
        `Evolution instance ${evolutionInstance} not found during message send, delaying job (order ${order.code}).`,
      );
      return;
    }

    if (isTemporaryProviderError(err)) {
      throw err;
    }
    throw err;
  }
}

export const messageWorker = new Worker("message-processing", processOrderMessage, {
  connection,
  concurrency: 1,
  lockDuration: 60000,
  stalledInterval: 30000,
  maxStalledCount: 2,
});

messageWorker.on("completed", (job) => {
  console.log(`Job ${job.id} completed successfully.`);
});

messageWorker.on("failed", (job, err) => {
  console.error(`Job ${job?.id} falhou:`, err.message);
});

messageWorker.on("error", (err) => {
  console.error("Erro no worker:", err);
});

async function shutdown() {
  console.log("Shutting down worker...");
  await messageWorker.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
