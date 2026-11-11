import { ZenithErrors } from "../../../core/errors.ts";

/**
 * Enterprise ERP Router
 * Endpoints REST nativos para operaciones críticas del ERP.
 */
export function createERPRouter(Zen: any) {
  const routes = [
    {
      method: "POST",
      path: "/zen/erp/products",
      handler: async (req: Request, _ctx: any) => {
        try {
          const body = await req.json();
          if (!body.sku || !body.name || body.salePrice === undefined) {
             throw ZenithErrors.invalidRequest("SKU, Name y SalePrice son obligatorios.");
          }
          
          const product = await Zen.DB.insert("Product", {
             ...body,
             createdAt: new Date().toISOString(),
             updatedAt: new Date().toISOString()
          });

          return new Response(JSON.stringify(product), { status: 201, headers: { "Content-Type": "application/json" } });
        } catch (error: any) {
          return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
      }
    },
    {
      method: "GET",
      path: "/zen/erp/inventory/:productId/stock",
      handler: async (req: Request, _ctx: any) => {
         try {
           const urlPattern = new URLPattern({ pathname: "/zen/erp/inventory/:productId/stock" });
           const match = urlPattern.exec(req.url);
           const productId = match?.pathname.groups.productId;
           
           if (!productId) throw ZenithErrors.invalidRequest("Falta productId.");

           const product = await Zen.DB.read("Product", productId);
           if (!product) throw ZenithErrors.notFound("Product not found");

           // Buscar inventario detallado por almacén
           const inventory = await Zen.DB.find("Inventory", { 
             where: { "product.objectId": productId } 
           });

           return new Response(JSON.stringify({
             globalStock: product.stockQty || 0,
             warehouseDetails: inventory
           }), { status: 200, headers: { "Content-Type": "application/json" } });
         } catch (error: any) {
           return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: { "Content-Type": "application/json" } });
         }
      }
    },
    {
      method: "POST",
      path: "/zen/erp/orders/:orderId/fulfill",
      handler: async (req: Request, ctx: any) => {
         try {
           const urlPattern = new URLPattern({ pathname: "/zen/erp/orders/:orderId/fulfill" });
           const match = urlPattern.exec(req.url);
           const orderId = match?.pathname.groups.orderId;
           
           // Ejecuta la Cloud Function que maneja la transacción
           const result = await Zen.Cloud.run("erp_fulfillOrder", { orderId }, { master: true, user: ctx.user });
           
           return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
         } catch (error: any) {
           return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: { "Content-Type": "application/json" } });
         }
      }
    }
  ];

  return routes;
}
