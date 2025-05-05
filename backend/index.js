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
  // Eliminar símbolos de moneda, espacios y puntos de miles, convertir comas a puntos decimales
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
    pvpExcel: cleanCurrency(row.PVP), // Limpiamos el formato del PVP del Excel
    costoActual: cleanCurrency(row.COSTO_ACTUAL),  // Nuevo campo
    utilidad: cleanCurrency(row.UTILIDAD)
  })).filter(item => item.idFabricante);

  console.log("Datos extraídos del Excel:", productos);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const resultados = [];

  try {
    for (const producto of productos) {
      const query = producto.idFabricante;
      console.log(`Buscando: ${query} - ${producto.nombreArticulo}`);
      
      try {
        await page.goto(`https://www.fravega.com/l/?keyword=${query}`, { waitUntil: 'domcontentloaded' });

        // Intentar escribir código postal
        try {
          await page.waitForSelector('#header-geo-location-form-postal-number', { timeout: 8000 });
          await page.fill('#header-geo-location-form-postal-number', '4000');
          await page.click('button.sc-fUBkdm.hzOXoT.sc-fYKINB.itCihk');
          await page.waitForTimeout(3000);
        } catch (err) {
          console.log("No fue necesario ingresar código postal o ya estaba ingresado.");
        }

        try {
          await page.waitForSelector('a.sc-4007e61d-0.dcODtv', { timeout: 8000 });

          const href = await page.$eval('a.sc-4007e61d-0.dcODtv', a => a.href);

          const productPage = await browser.newPage();
          await productPage.goto(href, { waitUntil: 'domcontentloaded', timeout: 15000 });

          const productoEncontrado = await productPage.evaluate((cleanCurrencyFn) => {
            const getText = (selector) => {
              const el = document.querySelector(selector);
              return el ? el.textContent.trim() : null;
            };

            const getSrc = (selector) => {
              const el = document.querySelector(selector);
              return el ? el.src : null;
            };

            // Función para limpiar valores monetarios en el navegador
            const cleanCurrencyBrowser = (value) => {
              if (!value) return null;
              const cleaned = String(value)
                .replace(/[^\d,-]/g, '')
                .replace('.', '')
                .replace(',', '.');
              return parseFloat(cleaned) || null;
            };

            const pvpantes = getText('span.sc-66d25270-0.sc-2628e4d4-4.eiLwiO.kGdyWX');
            const porcentajedescuentoText = getText('span.sc-1d9b1d9e-0.sc-2628e4d4-3.OZgQ.jLjuuY');
            const pvpactual = getText('span.sc-e2aca368-0.sc-2628e4d4-5.juwGno.ehTQUi');

            return {
              pvpantes: cleanCurrencyBrowser(pvpantes),
              porcentajedescuento: porcentajedescuentoText ? cleanCurrencyBrowser(porcentajedescuentoText.replace('%', '')) : null,
              pvpactual: cleanCurrencyBrowser(pvpactual),
              envio: getText('div.sc-2628e4d4-9.jAXbur'),
              imagen: getSrc('img.imgSmall'),
              linkproducto: window.location.href
            };
          }, cleanCurrency.toString());

          await productPage.close();

          resultados.push({
            ...productoEncontrado,
            idFabricante: query,
            nombreArticulo: producto.nombreArticulo,
            pvpExcel: producto.pvpExcel,
            costoActual: producto.costoActual,
            utilidad: producto.utilidad,
            // Cálculos adicionales con valores limpios
            diferenciaPvp: productoEncontrado.pvpactual && producto.pvpExcel ? 
                          (productoEncontrado.pvpactual - producto.pvpExcel) : null,
            margen: productoEncontrado.pvpactual && producto.costoActual ? 
                   ((productoEncontrado.pvpactual - producto.costoActual) / productoEncontrado.pvpactual * 100) : null
          });
          
        } catch (err) {
          console.warn(`No se encontró producto para ${query}:`, err.message);
          resultados.push({
            idFabricante: query,
            nombreArticulo: producto.nombreArticulo,
            pvpExcel: producto.pvpExcel,
            costoActual: producto.costoActual,
            utilidad: producto.utilidad,
            error: "Producto no encontrado"
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