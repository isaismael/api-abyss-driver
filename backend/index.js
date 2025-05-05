const express = require('express');
const { chromium } = require('playwright');
const cors = require('cors');
const multer = require('multer');
const xlsx = require('xlsx');

const app = express();
const PORT = 3000;

// Configuración de multer para subir el archivo Excel
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.use(cors());
app.use(express.static('public'));

// Función para limpiar y convertir valores monetarios
const cleanCurrency = (value) => {
  if (!value) return null;
  const cleaned = String(value)
    .replace(/[^\d,-]/g, '')
    .replace('.', '')
    .replace(',', '.');
  return parseFloat(cleaned) || null;
};

// Ruta principal que recibe el Excel y hace el scraping
app.post('/importar-excel', upload.single('file'), async (req, res) => {
  const file = req.file;

  if (!file) {
    return res.status(400).send('No se subió ningún archivo.');
  }

  console.log("Archivo recibido:", file.originalname);

  // Leer el archivo Excel
  const workbook = xlsx.read(file.buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const dataExcel = xlsx.utils.sheet_to_json(sheet);
  
  // Extraer tanto los IDs como los nombres de los artículos
  const productos = dataExcel.map(row => ({
    idFabricante: row.ID_FRABRICANTE,
    nombreArticulo: row.NOMBRES_DEL_ARTICULO,
    pvpExcel: cleanCurrency(row.PVP),
    costoActual: cleanCurrency(row.COSTO_ACTUAL),
    utilidad: cleanCurrency(row.UTILIDAD)
  })).filter(item => item.idFabricante);

  console.log("Datos extraídos del Excel:", productos);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const resultados = [];

  try {
    for (const producto of productos) {
      const query = producto.idFabricante;
      console.log(`\nBuscando: ${query} - ${producto.nombreArticulo}`);
      
      try {
        await page.goto(`https://www.fravega.com/l/?keyword=${query}`, { waitUntil: 'networkidle', timeout: 15000 });

        // Intentar escribir código postal
        try {
          await page.waitForSelector('#header-geo-location-form-postal-number', { timeout: 5000 });
          await page.fill('#header-geo-location-form-postal-number', '4000');
          await page.click('button.sc-fUBkdm.hzOXoT.sc-fYKINB.itCihk');
          await page.waitForTimeout(3000);
        } catch (err) {
          console.log("No fue necesario ingresar código postal o ya estaba ingresado.");
        }

        try {
          await page.waitForSelector('a.sc-4007e61d-0.dcODtv', { timeout: 10000 });
          const href = await page.$eval('a.sc-4007e61d-0.dcODtv', a => a.href);

          const productPage = await browser.newPage();
          await productPage.goto(href, { waitUntil: 'networkidle', timeout: 20000 });

          // Solución mejorada para extraer promociones bancarias
          const productoEncontrado = await productPage.evaluate(async () => {
            const getText = (selector) => {
              const el = document.querySelector(selector);
              return el ? el.textContent.trim() : null;
            };

            const getSrc = (selector) => {
              const el = document.querySelector(selector);
              return el ? el.src : null;
            };

            // Función mejorada para extraer promociones
            const extractPromotions = () => {
              try {
                const paymentTooltip = document.querySelector('[data-test-id="payment-tooltip"]');
                if (!paymentTooltip) return null;

                const promotions = [];
                const title = paymentTooltip.querySelector('p')?.textContent.trim() || 'Promociones bancarias';

                // Extraer todas las opciones de pago
                const paymentOptions = paymentTooltip.querySelectorAll('div[class*="sc-f6cfc5e5-0"]');
                
                paymentOptions.forEach(option => {
                  const spans = option.querySelectorAll('span[class*="sc-f6cfc5e5-10"] span');
                  if (spans.length >= 2) {
                    const cuotas = spans[0].textContent.trim();
                    const monto = spans[1].textContent.trim();
                    if (cuotas && monto) {
                      promotions.push(`${cuotas} cuotas sin interés de ${monto}`);
                    }
                  }
                });

                return promotions.length > 0 ? promotions.join('\n') : null;
              } catch (e) {
                console.error('Error al extraer promociones:', e);
                return null;
              }
            };

            // Esperar un momento para que cargue el contenido dinámico
            await new Promise(resolve => setTimeout(resolve, 2000));

            const cuotas = extractPromotions();

            return {
              cuotas: cuotas,
              pvpantes: getText('span.sc-66d25270-0.sc-2628e4d4-4.eiLwiO.kGdyWX'),
              porcentajedescuento: getText('span.sc-1d9b1d9e-0.sc-2628e4d4-3.OZgQ.jLjuuY'),
              pvpactual: getText('span.sc-e2aca368-0.sc-2628e4d4-5.juwGno.ehTQUi'),
              envio: getText('div.sc-2628e4d4-9.jAXbur'),
              imagen: getSrc('img.imgSmall'),
              linkproducto: window.location.href
            };
          });

          // Mostrar promociones en consola
          if (productoEncontrado.cuotas) {
            console.log('\n=== PROMOCIONES BANCARIAS ===');
            console.log(productoEncontrado.cuotas);
          } else {
            console.log('\nNo se encontraron promociones bancarias');
          }

          // Limpiar valores monetarios
          productoEncontrado.pvpantes = cleanCurrency(productoEncontrado.pvpantes);
          productoEncontrado.porcentajedescuento = productoEncontrado.porcentajedescuento ? 
            cleanCurrency(productoEncontrado.porcentajedescuento.replace('%', '')) : null;
          productoEncontrado.pvpactual = cleanCurrency(productoEncontrado.pvpactual);

          await productPage.close();

          resultados.push({
            ...productoEncontrado,
            idFabricante: query,
            nombreArticulo: producto.nombreArticulo,
            pvpExcel: producto.pvpExcel,
            costoActual: producto.costoActual,
            utilidad: producto.utilidad,
            diferenciaPvp: productoEncontrado.pvpactual && producto.pvpExcel ? 
              (productoEncontrado.pvpactual - producto.pvpExcel) : null,
            margen: productoEncontrado.pvpactual && producto.costoActual ? 
              ((productoEncontrado.pvpactual - producto.costoActual) / productoEncontrado.pvpactual * 100) : null
          });
          
        } catch (err) {
          console.warn(`Error al procesar producto ${query}:`, err.message);
          resultados.push({
            idFabricante: query,
            nombreArticulo: producto.nombreArticulo,
            pvpExcel: producto.pvpExcel,
            costoActual: producto.costoActual,
            utilidad: producto.utilidad,
            error: err.message.includes('timeout') ? "Timeout al cargar página" : "Error al procesar producto"
          });
        }
      } catch (err) {
        console.error(`Error al buscar ${query}:`, err);
        resultados.push({
          idFabricante: query,
          nombreArticulo: producto.nombreArticulo,
          pvpExcel: producto.pvpExcel,
          costoActual: producto.costoActual,
          utilidad: producto.utilidad,
          error: "Error en la búsqueda"
        });
      }
    }

    res.json(resultados);

  } catch (error) {
    console.error('Error general durante scraping:', error);
    res.status(500).send('Error durante el scraping');
  } finally {
    setTimeout(async () => {
      await browser.close();
    }, 5000);
  }
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});