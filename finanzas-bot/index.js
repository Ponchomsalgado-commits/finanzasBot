require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const { GoogleGenerativeAI } = require('@google/generative-ai'); // Integración de IA

// 1. Conexión a MongoDB Atlas
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('🟢 Conectado exitosamente a MongoDB Atlas'))
    .catch(err => console.error('🔴 Error conectando a MongoDB:', err));

// 2. Definir el Esquema y Modelo
const transaccionSchema = new mongoose.Schema({
    tipo: { type: String, enum: ['gasto', 'ingreso', 'transferencia'], required: true },
    cantidad: { type: Number, required: true },
    cantidadRecibida: { type: Number }, // Para transferencias cruzadas
    concepto: { type: String, required: true },
    cuenta: { type: String, enum: ['efectivo', 'arq', 'banorte', 'ahorros'], required: true },
    cuentaDestino: { type: String, enum: ['efectivo', 'arq', 'banorte', 'ahorros'] }, 
    fecha: { type: Date, default: Date.now }
});

const Transaccion = mongoose.model('Transaccion', transaccionSchema);

// 3. Inicializamos las APIs externas (Gemini y ExchangeRate)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function obtenerTipoCambio() {
    try {
        const response = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
        const data = await response.json();
        return data.rates.MXN; 
    } catch (error) {
        console.error('Error al obtener el dólar:', error);
        return 17.00; // Valor de emergencia
    }
}

// 4. Inicializar el Bot de Telegram
const bot = new Telegraf(process.env.BOT_TOKEN);

bot.start((ctx) => {
    ctx.reply('¡Hola! Soy tu bot de finanzas impulsado por IA.\n\nPuedes hablarme normal, por ejemplo:\n"Me gasté 150 en tacos de mi banorte"\n"Transfiere 50 dólares físicos al cochinito"');
});

// 📌 5. COMANDOS: Balance Multidivisa
bot.command('balance', async (ctx) => {
    try {
        const transacciones = await Transaccion.find();
        let saldos = { efectivo: 0, arq: 0, banorte: 0, ahorros: 0 };

        transacciones.forEach(t => {
            if (t.tipo === 'ingreso') {
                saldos[t.cuenta] += t.cantidad;
            } else if (t.tipo === 'gasto') {
                saldos[t.cuenta] -= t.cantidad;
            } else if (t.tipo === 'transferencia') {
                saldos[t.cuenta] -= t.cantidad; 
                saldos[t.cuentaDestino] += (t.cantidadRecibida || t.cantidad); 
            }
        });

        const totalPesos = saldos.efectivo + saldos.banorte;
        const totalDolares = saldos.arq + saldos.ahorros;
        const precioDolar = await obtenerTipoCambio();
        const patrimonioGlobalMXN = totalPesos + (totalDolares * precioDolar);

        const mensajeBalance = `📊 *ESTADO DE CUENTAS*\n` +
            `💵 Dólar actual: $${precioDolar.toFixed(2)} MXN\n\n` +
            `🇲🇽 *Cuentas en Pesos (MXN)*\n` +
            `💵 Efectivo: $${saldos.efectivo.toFixed(2)}\n` +
            `🏦 Banorte: $${saldos.banorte.toFixed(2)}\n` +
            `🔹 Total MXN: $${totalPesos.toFixed(2)}\n\n` +
            `🇺🇸 *Cuentas en Dólares (USD)*\n` +
            `🏢 ARQ: $${saldos.arq.toFixed(2)}\n` +
            `🐷 Ahorros: $${saldos.ahorros.toFixed(2)}\n` +
            `🔹 Total USD: $${totalDolares.toFixed(2)}\n` +
            `➖➖➖➖➖➖➖➖\n` +
            `💰 *PATRIMONIO TOTAL: $${patrimonioGlobalMXN.toFixed(2)} MXN*`;

        ctx.reply(mensajeBalance, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error(error);
        ctx.reply('❌ Hubo un error al calcular tus saldos.');
    }
});

// 📌 6. PROCESAMIENTO DE LENGUAJE NATURAL CON GEMINI AI
bot.on('text', async (ctx) => {
    const mensajeUsuario = ctx.message.text.trim();
    if (mensajeUsuario.startsWith('/')) return; // Ignorar comandos mal escritos

    const mensajeEspera = await ctx.reply('🤔 Analizando transacción...');

    try {
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            generationConfig: { responseMimeType: "application/json" }
        });

        const prompt = `
        Eres el backend de una app financiera. Analiza este mensaje del usuario y extrae los datos.
        
        DICCIONARIO Y REGLAS ESTRICTAS:
        1. Tipos de movimiento: 
           - Si el usuario dice "compré", "pagué", "me costó", "gasté", es un "gasto".
           - Si dice "me pagaron", "gané", "recibí", es un "ingreso".
           - Si mueve dinero entre sus propias cuentas, es "transferencia".
        2. Cuentas válidas: "efectivo", "arq", "banorte", "ahorros". (Si dice "banco" o "tarjeta" = banorte. Si dice "dólares físicos" = arq. Si dice "cochinito" = ahorros).
        3. Regla de oro: Si el usuario menciona un GASTO pero NO dice con qué pagó, asume AUTOMÁTICAMENTE que la cuenta es "efectivo".
        4. Si falta el concepto del gasto/ingreso, usa "Varios".
        
        Devuelve ÚNICAMENTE un objeto JSON válido, sin texto extra, sin formato markdown, con esta estructura exacta:
        {"tipo": "gasto", "cantidad": 60, "concepto": "soda", "cuenta": "efectivo", "cuentaDestino": null}
        
        Mensaje del usuario: "${mensajeUsuario}"
        `;

        const result = await model.generateContent(prompt);
        const respuestaIA = result.response.text();
        const datosGenerados = JSON.parse(respuestaIA);

        let transaccionData = null;
        let mensajeRespuesta = "";

        if (datosGenerados.tipo === 'gasto' || datosGenerados.tipo === 'ingreso') {
            transaccionData = {
                tipo: datosGenerados.tipo,
                cantidad: datosGenerados.cantidad,
                concepto: datosGenerados.concepto || 'Varios',
                cuenta: datosGenerados.cuenta
            };
            const icono = transaccionData.tipo === 'ingreso' ? '📈' : '📉';
            mensajeRespuesta = `${icono} ¡${transaccionData.tipo.toUpperCase()} Guardado!\n💰 $${transaccionData.cantidad} en ${transaccionData.concepto}\n🏦 Cuenta: ${transaccionData.cuenta.toUpperCase()}`;
        
        } else if (datosGenerados.tipo === 'transferencia') {
            const cuentasMXN = ['efectivo', 'banorte'];
            const origenEsMXN = cuentasMXN.includes(datosGenerados.cuenta);
            const destinoEsMXN = cuentasMXN.includes(datosGenerados.cuentaDestino);

            let cantidadFinal = datosGenerados.cantidad;
            let detalleConversion = "";

            if (origenEsMXN !== destinoEsMXN) {
                const precioDolar = await obtenerTipoCambio();
                if (origenEsMXN && !destinoEsMXN) {
                    const tasaVenta = precioDolar + 0.50;
                    cantidadFinal = datosGenerados.cantidad / tasaVenta;
                    detalleConversion = `\n💱 Tasa de cambio: $${tasaVenta.toFixed(2)}`;
                } else {
                    const tasaCompra = precioDolar - 0.50;
                    cantidadFinal = datosGenerados.cantidad * tasaCompra;
                    detalleConversion = `\n💱 Tasa de cambio: $${tasaCompra.toFixed(2)}`;
                }
            }

            transaccionData = {
                tipo: 'transferencia',
                cantidad: datosGenerados.cantidad,
                cantidadRecibida: parseFloat(cantidadFinal.toFixed(2)),
                concepto: 'Traspaso entre cuentas',
                cuenta: datosGenerados.cuenta,
                cuentaDestino: datosGenerados.cuentaDestino
            };
            
            mensajeRespuesta = `🔄 ¡TRANSFERENCIA Guardada!\n📤 Salió: ${datosGenerados.cantidad} (${datosGenerados.cuenta.toUpperCase()})\n📥 Entró: ${cantidadFinal.toFixed(2)} (${datosGenerados.cuentaDestino.toUpperCase()})${detalleConversion}`;
        }

        const nuevaTransaccion = new Transaccion(transaccionData);
        await nuevaTransaccion.save();

        ctx.telegram.editMessageText(ctx.chat.id, mensajeEspera.message_id, null, mensajeRespuesta, {
            reply_markup: {
                inline_keyboard: [[ Markup.button.callback('❌ Borrar registro', `del_${nuevaTransaccion._id}`) ]]
            }
        });

   } catch (error) {
        console.error("Error procesando con IA:", error);
        ctx.telegram.editMessageText(ctx.chat.id, mensajeEspera.message_id, null, '❌ No pude entender esa instrucción. Intenta ser un poco más claro con la cantidad y las cuentas.');
    }
});

// 📌 7. LÓGICA DE BOTONES PARA BORRAR REGISTROS
bot.action(/^del_(.+)$/, async (ctx) => {
    const idTransaccion = ctx.match[1]; 
    try {
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

// 📌 8. ARRANQUE DEL BOT Y SERVIDOR WEB FANTASMA (PARA RENDER)
bot.launch();
console.log('🤖 Bot de finanzas corriendo con Inteligencia Artificial...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

const http = require('http');
const puerto = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('El Bot de Finanzas Inteligente esta activo 🤖🧠');
    res.end();
}).listen(puerto, () => {
    console.log(`🌐 Servidor web fantasma escuchando en el puerto ${puerto}`);
});