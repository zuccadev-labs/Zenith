import { ZenithErrors } from "../../../core/errors.ts";

/**
 * ERP Triggers & Webhooks
 * Lógica transaccional de negocio: inventario, facturación y auditorías.
 */

export function registerERPTriggers(Zen: any) {
  
  // Validar consistencia antes de crear una Factura
  Zen.Cloud.beforeSave("Invoice", async (request: any) => {
    const invoice = request.object;
    
    if (!invoice.number) {
       // Autogenerar número de factura si no existe
       invoice.number = `INV-${Date.now()}`;
    }

    if (!invoice.customer) {
      throw ZenithErrors.invalidRequest("Toda factura debe tener un cliente asignado.");
    }

    // Calcular totales asegurando integridad transaccional
    if (invoice.lines && Array.isArray(invoice.lines)) {
      let subtotal = 0;
      for (const line of invoice.lines) {
         subtotal += (line.price * line.qty);
      }
      invoice.subtotal = subtotal;
      invoice.total = subtotal + (invoice.tax || 0);
    }
  });

  // Auditoría automática en ScyllaDB para pagos
  Zen.Cloud.afterSave("Payment", async (request: any) => {
    const payment = request.object;
    
    if (payment.status === "completed" && payment.invoice) {
      // Actualizar la factura a pagada
      try {
        await Zen.DB.update("Invoice", payment.invoice.objectId, {
          status: "paid",
          paidAt: new Date().toISOString()
        });
        
        // Registrar en Auditoría (ScyllaDB Stream)
        await Zen.DB.insert("ERP_Audit", {
           action: "INVOICE_PAID",
           user: request.user ? { __type: "Pointer", className: "_User", objectId: request.user.objectId } : null,
           timestamp: new Date().toISOString(),
           referenceId: payment.invoice.objectId,
           new_state: { status: "paid", paymentId: payment.objectId }
        });
      } catch (e) {
        console.error("[ERP Audit] Error processing payment:", e);
      }
    }
  });

  // Cloud Function: Cumplir orden y reducir inventario
  Zen.Cloud.define("erp_fulfillOrder", async (request: any) => {
    const { orderId } = request.params;
    
    // Iniciar "transacción" (o lógica equivalente)
    const order = await Zen.DB.read("Order", orderId);
    if (!order) throw ZenithErrors.notFound("Order not found");
    if (order.status !== "approved") throw ZenithErrors.invalidRequest("Order is not approved for fulfillment");

    // Reducir inventario por cada item (Lógica simplificada para demo)
    for (const item of order.items) {
      if (!item.product || !item.product.objectId) continue;
      
      const product = await Zen.DB.read("Product", item.product.objectId);
      if (product) {
        const newStock = Math.max(0, (product.stockQty || 0) - item.qty);
        await Zen.DB.update("Product", product.objectId, { stockQty: newStock });
      }
    }

    await Zen.DB.update("Order", orderId, { status: "fulfilled" });
    
    // Log auditoría
    await Zen.DB.insert("ERP_Audit", {
      action: "ORDER_FULFILLED",
      user: request.user ? { __type: "Pointer", className: "_User", objectId: request.user.objectId } : null,
      timestamp: new Date().toISOString(),
      referenceId: orderId,
    });

    return { success: true, message: "Order fulfilled and inventory updated." };
  });

}
