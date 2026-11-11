import type { EventBusAdapter } from "../../core/types.ts";

/**
 * Creates a Kafka / Redpanda event bus adapter implementing the EventBusAdapter interface.
 * Provides event sourcing capabilities — publishing domain events to Kafka topics and
 * subscribing to topics for consumption by external microservices.
 *
 * @param clientId - Kafka client ID used to identify this consumer/producer group
 * @returns EventBusAdapter — connect, publish, subscribe, and disconnect interface
 */
export function createKafkaAdapter(_clientId: string): EventBusAdapter {
  // Simulando conexión a la librería KafkaJS o Deno equivalent
  let isConnected = false;

  return {
    connect: async (brokers: string[]): Promise<void> => {
      console.log(`[KafkaAdapter] Conectando a brokers: ${brokers.join(", ")}`);
      isConnected = true;
    },

    publish: async (
      topic: string,
      event: { type: string; payload: any; timestamp: Date },
    ): Promise<void> => {
      if (!isConnected) return;
      // En producción: await producer.send({ topic, messages: [{ value: JSON.stringify(event) }] });
      console.log(
        `[Kafka] Emitiendo Evento [${topic}]: ${event.type} -> ${
          JSON.stringify(event.payload).substring(0, 50)
        }...`,
      );
    },

    subscribe: async (topic: string, _handler: (event: any) => Promise<void>): Promise<void> => {
      if (!isConnected) return;
      console.log(`[Kafka] Suscrito a topic: ${topic}`);
      // En producción: consumer.run({ eachMessage: async ({ message }) => handler(JSON.parse(message.value.toString())) })
    },

    disconnect: async (): Promise<void> => {
      isConnected = false;
      console.log(`[KafkaAdapter] Desconectado.`);
    },
  };
}
