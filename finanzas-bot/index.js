require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');

// 1. Conexión a MongoDB Atlas
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('🟢 Conectado exitosamente a MongoDB Atlas'))
    .catch(err => console.error('🔴 Error conectando a MongoDB:', err));

// 2. Definir el Esquema y Modelo
const transaccionSchema = new mongoose.Schema({
    tipo: { type: String, enum: ['gasto', 'ingreso', 'transferencia'], required: true },
    cantidad: { type: Number, required: true },
    cantidadRecibida: { type: Number }, // NUEVO: Para transferencias cruzadas
    concepto: { type: String, required: true },
    cuenta: { type: String, enum: ['efectivo', 'arq', 'banorte', 'ahorros'], required: true },
    cuentaDestino: { type: String, enum: ['efectivo', 'arq', 'banorte', 'ahorros'] }, 
    fecha: { type: Date, default: Date.now }
});

const Transaccion = mongoose.model('Transaccion', transaccionSchema);

// 3. Función para obtener el tipo de cambio en tiempo real
async function obtenerTipoCambio() {
    try {
        // Usamos una API gratuita que se actualiza cada 24 hrs
        const response = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
        const data = await response.json();
        return data.rates.MXN; // Retorna el valor actual, ej: 16.80
    } catch (error) {
        console.error('Error al obtener el dólar:', error);
        return 17.00; // Un valor "de emergencia" por si la API falla
    }
}





// 3. Inicializar el Bot
const bot = new Telegraf(process.env.BOT_TOKEN);

bot.start((ctx) => {
    ctx.reply('¡Hola! Soy tu bot de finanzas.\n\nFormato: [gasto/ingreso] [cantidad] [concepto] [método]\nTransferencia: transferencia [cantidad] [cuenta_origen] a [cuenta_destino]');
});

// 📌 4. COMANDOS ESPECÍFICOS PRIMERO (Para que no se confundan con texto normal)
// Comando para consultar el Balance Múltiple



// Comando para consultar el Balance Multidivisa
bot.command('balance', async (ctx) => {
    try {
        const transacciones = await Transaccion.find();
        let saldos = { efectivo: 0, arq: 0, banorte: 0, ahorros: 0 };

        // Procesamos la matemática cuenta por cuenta
        transacciones.forEach(t => {
            if (t.tipo === 'ingreso') {
                saldos[t.cuenta] += t.cantidad;
            } else if (t.tipo === 'gasto') {
                saldos[t.cuenta] -= t.cantidad;
            } else if (t.tipo === 'transferencia') {
                saldos[t.cuenta] -= t.cantidad; // Sale de la cuenta origen
                // Entra a la cuenta destino (usa la recibida si hubo conversión, si no, la original)
                saldos[t.cuentaDestino] += (t.cantidadRecibida || t.cantidad); 
            }
        });

        // Separamos los saldos por moneda
        const totalPesos = saldos.efectivo + saldos.banorte;
        const totalDolares = saldos.arq + saldos.ahorros;

        // Obtenemos el precio del dólar en este exacto momento
        const precioDolar = await obtenerTipoCambio();
        
        // Calculamos el patrimonio total en MXN
        const patrimonioGlobalMXN = totalPesos + (totalDolares * precioDolar);

        const mensajeBalance = `📊 *ESTADO DE CUENTAS*\n` +
            `💵 Dólar actual: $${precioDolar.toFixed(2)} MXN\n\n` +
            `🇲🇽 *Cuentas en Pesos (MXN)*\n` +
            `💵 Efectivo:       $${saldos.efectivo.toFixed(2)}\n` +
            `🟥 Banorte:        $${saldos.banorte.toFixed(2)}\n` +
            `🔹 Total MXN:   $${totalPesos.toFixed(2)}\n\n` +
            `🇺🇸 *Cuentas en Dólares (USD)*\n` +
            `⬜ ARQ:             $${saldos.arq.toFixed(2)}\n` +
            `🐷 Ahorros:        $${saldos.ahorros.toFixed(2)}\n` +
            `🔹 Total USD:     $${totalDolares.toFixed(2)}\n` +
            `➖➖➖➖➖➖➖➖\n` +
            `💰 *PATRIMONIO TOTAL: $${patrimonioGlobalMXN.toFixed(2)} MXN*`;

        ctx.reply(mensajeBalance, { parse_mode: 'Markdown' });

    } catch (error) {
        console.error(error);
        ctx.reply('❌ Hubo un error al calcular tus saldos.');
    }
});
// 📌 5. LECTOR DE TEXTO NORMAL DESPUÉS
// Lógica principal: Recibir y Guardar
bot.on('text', async (ctx) => {
    const mensaje = ctx.message.text.trim();

    // Regex para GASTOS o INGRESOS (ej: gasto 150 tacos banorte)
    const regexNormal = /^(gasto|ingreso)\s+(\d+(?:\.\d{1,2})?)\s+(.+)\s+(efectivo|arq|banorte|ahorros)$/i;
    // Regex para TRANSFERENCIAS (ej: transferencia 500 banorte a ahorros)
    const regexTransferencia = /^transferencia\s+(\d+(?:\.\d{1,2})?)\s+(efectivo|arq|banorte|ahorros)\s+a\s+(efectivo|arq|banorte|ahorros)$/i;

    let transaccionData = null;
    let mensajeRespuesta = "";

    if (regexNormal.test(mensaje)) {
        const coincidencia = mensaje.match(regexNormal);
        transaccionData = {
            tipo: coincidencia[1].toLowerCase(),
            cantidad: parseFloat(coincidencia[2]),
            concepto: coincidencia[3].trim(),
            cuenta: coincidencia[4].toLowerCase()
        };
        const icono = transaccionData.tipo === 'ingreso' ? '📈' : '📉';
        mensajeRespuesta = `${icono} ¡${transaccionData.tipo.toUpperCase()} Guardado!\n💰 $${transaccionData.cantidad} en ${transaccionData.concepto}\n🏦 Cuenta: ${transaccionData.cuenta.toUpperCase()}`;
    
    } else if (regexTransferencia.test(mensaje)) {
        const coincidencia = mensaje.match(regexTransferencia);
        const cantidadOrigen = parseFloat(coincidencia[1]);
        const cuentaOrigen = coincidencia[2].toLowerCase();
        const cuentaDest = coincidencia[3].toLowerCase();
        
        // Clasificamos qué cuentas manejan qué moneda
        const cuentasMXN = ['efectivo', 'banorte'];
        const cuentasUSD = ['arq', 'ahorros'];

        const origenEsMXN = cuentasMXN.includes(cuentaOrigen);
        const destinoEsMXN = cuentasMXN.includes(cuentaDest);

        let cantidadFinal = cantidadOrigen;
        let detalleConversion = "";

        // Si cruzan divisas, hacemos la conversión
        if (origenEsMXN !== destinoEsMXN) {
            const precioDolar = await obtenerTipoCambio();
            
            if (origenEsMXN && !destinoEsMXN) {
                // MXN a USD (Compra de dólares -> +50 centavos de margen de casa de cambio)
                const tasaVenta = precioDolar + 0.50;
                cantidadFinal = cantidadOrigen / tasaVenta;
                detalleConversion = `\n💱 Tasa de cambio: $${tasaVenta.toFixed(2)}`;
            } else {
                // USD a MXN (Venta de dólares -> -50 centavos de margen)
                const tasaCompra = precioDolar - 0.50;
                cantidadFinal = cantidadOrigen * tasaCompra;
                detalleConversion = `\n💱 Tasa de cambio: $${tasaCompra.toFixed(2)}`;
            }
        }

        transaccionData = {
            tipo: 'transferencia',
            cantidad: cantidadOrigen,
            cantidadRecibida: parseFloat(cantidadFinal.toFixed(2)), // Guardamos lo que realmente llega
            concepto: 'Traspaso entre cuentas',
            cuenta: cuentaOrigen,
            cuentaDestino: cuentaDest
        };
        
        mensajeRespuesta = `🔄 ¡TRANSFERENCIA Guardada!\n📤 Salió: ${cantidadOrigen} (${cuentaOrigen.toUpperCase()})\n📥 Entró: ${cantidadFinal.toFixed(2)} (${cuentaDest.toUpperCase()})${detalleConversion}`;
    }

    // Si detectó un formato válido, lo guarda en BD
    if (transaccionData) {
        try {
            const nuevaTransaccion = new Transaccion(transaccionData);
            await nuevaTransaccion.save();

            ctx.reply(mensajeRespuesta, Markup.inlineKeyboard([
                Markup.button.callback('❌ Borrar registro', `del_${nuevaTransaccion._id}`)
            ]));
        } catch (error) {
            console.error(error);
            ctx.reply('❌ Error al guardar en la base de datos.');
        }
    } else {
        ctx.reply('❌ Formato incorrecto.\nNormal: gasto 150 tacos banorte\nTransferencia: transferencia 500 banorte a ahorros');
    }
});

// 📌 6. LÓGICA DE BOTONES Y ARRANQUE AL FINAL
// Lógica para Borrar usando el ID de MongoDB
bot.action(/^del_(.+)$/, async (ctx) => {
    const idTransaccion = ctx.match[1]; // Extraemos el ID de MongoDB

    try {
        // Buscamos y eliminamos el documento en la base de datos
        const transaccionBorrada = await Transaccion.findByIdAndDelete(idTransaccion);

        if (transaccionBorrada) {
            ctx.editMessageText('🗑️ Registro eliminado de la base de datos exitosamente.');
        } else {
            ctx.editMessageText('⚠️ Este registro ya había sido eliminado o no se encontró.');
        }
    } catch (error) {
        console.error(error);
        ctx.answerCbQuery('Error al intentar borrar el registro.');
    }
});

bot.launch();
console.log('🤖 Bot de finanzas corriendo...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// Servidor Web "Fantasma" para engañar a Render y evitar el error 254
const http = require('http');
const puerto = process.env.PORT || 3000;

http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('El Bot de Finanzas esta activo 🤖');
    res.end();
}).listen(puerto, () => {
    console.log(`🌐 Servidor web fantasma escuchando en el puerto ${puerto}`);
});