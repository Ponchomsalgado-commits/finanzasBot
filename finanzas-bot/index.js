require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const { GoogleGenerativeAI } = require('@google/generative-ai'); 

// 1. Conexión a MongoDB Atlas
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('🟢 Conectado exitosamente a MongoDB Atlas'))
    .catch(err => console.error('🔴 Error conectando a MongoDB:', err));

// 2. Definir el Esquema y Modelo
const transaccionSchema = new mongoose.Schema({
    tipo: { type: String, enum: ['gasto', 'ingreso', 'transferencia'], required: true },
    cantidad: { type: Number, required: true },
    cantidadRecibida: { type: Number }, 
    concepto: { type: String, required: true },
    cuenta: { type: String, enum: ['efectivo', 'arq', 'BBVA', 'ahorros'], required: true },
    cuentaDestino: { type: String, enum: ['efectivo', 'arq', 'BBVA', 'ahorros'] }, 
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
    ctx.reply('¡Hola! Soy tu bot de finanzas impulsado por IA.\n\nPuedes hablarme normal, por ejemplo:\n"Me gasté 150 en tacos de mi BBVA"\n"Transfiere 50 dólares físicos al cochinito"\n"Editar BBVA a 250"');
});

// 📌 5. COMANDOS: Balance Multidivisa
bot.command('balance', async (ctx) => {
    try {
        const transacciones = await Transaccion.find();
        let saldos = { efectivo: 0, arq: 0, BBVA: 0, ahorros: 0 };

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

        // 'ahorros' ahora suma en pesos
        const totalPesos = saldos.efectivo + saldos.BBVA + saldos.ahorros;
        const totalDolares = saldos.arq;
        const precioDolar = await obtenerTipoCambio();
        const patrimonioGlobalMXN = totalPesos + (totalDolares * precioDolar);

        const mensajeBalance = `📊 *ESTADO DE CUENTAS*\n` +
            `💵 Dólar actual: $${precioDolar.toFixed(2)} MXN\n\n` +
            `🇲🇽 *Cuentas en Pesos (MXN)*\n` +
            `💵 Efectivo: $${saldos.efectivo.toFixed(2)}\n` +
            `🏦 BBVA: $${saldos.BBVA.toFixed(2)}\n` +
            `🐷 Ahorros: $${saldos.ahorros.toFixed(2)}\n` +
            `🔹 Total MXN: $${totalPesos.toFixed(2)}\n\n` +
            `🇺🇸 *Cuentas en Dólares (USD)*\n` +
            `🏢 ARQ: $${saldos.arq.toFixed(2)}\n` +
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

    const mensajeEspera = await ctx.reply('🤔 Analizando...');

    try {
        const model = genAI.getGenerativeModel({ 
            model: "gemini-3.1-flash-lite",
            generationConfig: { responseMimeType: "application/json" }
        });

        const prompt = `
        Eres el backend de una app financiera. Analiza este mensaje del usuario y extrae los datos.
        
        DICCIONARIO Y REGLAS ESTRICTAS:
        1. Tipos de movimiento: 
           - "gasto": Si dice "compré", "pagué", "me costó", "gasté".
           - "ingreso": Si dice "me pagaron", "gané", "recibí".
           - "transferencia": Si mueve dinero entre sus propias cuentas.
           - "ajuste": Si el usuario dice "editar", "ajustar", "cambiar", o establece un nuevo balance/saldo final (ej. "editar BBVA 250", "mi saldo en banco es 200").
        2. Cuentas válidas: "efectivo", "arq", "BBVA", "ahorros". (Si dice "banco" o "tarjeta" = BBVA. Si dice "dólares físicos" = arq. Si dice "cochinito" = ahorros).
        3. Regla de oro: Si menciona un GASTO pero NO dice con qué pagó, asume AUTOMÁTICAMENTE que la cuenta es "efectivo".
        4. Concepto: Si falta el concepto, usa "Varios". Si es un ajuste, usa "Ajuste manual".
        5. IMPORTANTE PARA AJUSTES: Si el tipo es "ajuste", la "cantidad" DEBE SER el saldo FINAL EXACTO que el usuario quiere tener en esa cuenta.
        
        Devuelve ÚNICAMENTE un objeto JSON válido, sin texto extra, con esta estructura:
        {"tipo": "ajuste", "cantidad": 250, "concepto": "Ajuste manual", "cuenta": "BBVA", "cuentaDestino": null}
        
        Mensaje del usuario: "${mensajeUsuario}"
        `;

        const result = await model.generateContent(prompt);
        const respuestaIA = result.response.text();
        const datosGenerados = JSON.parse(respuestaIA);

        let transaccionData = null;
        let mensajeRespuesta = "";
        let nuevaTransaccion = null;

        // 🧮 LÓGICA 1: GASTOS E INGRESOS
        if (datosGenerados.tipo === 'gasto' || datosGenerados.tipo === 'ingreso') {
            transaccionData = {
                tipo: datosGenerados.tipo,
                cantidad: datosGenerados.cantidad,
                concepto: datosGenerados.concepto || 'Varios',
                cuenta: datosGenerados.cuenta
            };
            const icono = transaccionData.tipo === 'ingreso' ? '📈' : '📉';
            mensajeRespuesta = `${icono} ¡${transaccionData.tipo.toUpperCase()} Guardado!\n💰 $${transaccionData.cantidad} en ${transaccionData.concepto}\n🏦 Cuenta: ${transaccionData.cuenta.toUpperCase()}`;
        
        // 🧮 LÓGICA 2: TRANSFERENCIAS
        } else if (datosGenerados.tipo === 'transferencia') {
            // 'ahorros' ahora está en la lista de cuentas en MXN
            const cuentasMXN = ['efectivo', 'BBVA', 'ahorros'];
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
        
        // 🧮 LÓGICA 3: AJUSTES MANUALES
        } else if (datosGenerados.tipo === 'ajuste') {
            const cuentaObjetivo = datosGenerados.cuenta;
            const saldoDeseado = datosGenerados.cantidad;
            
            const transacciones = await Transaccion.find();
            let saldoActual = 0;

            transacciones.forEach(t => {
                if (t.tipo === 'ingreso' && t.cuenta === cuentaObjetivo) saldoActual += t.cantidad;
                else if (t.tipo === 'gasto' && t.cuenta === cuentaObjetivo) saldoActual -= t.cantidad;
                else if (t.tipo === 'transferencia') {
                    if (t.cuenta === cuentaObjetivo) saldoActual -= t.cantidad;
                    if (t.cuentaDestino === cuentaObjetivo) saldoActual += (t.cantidadRecibida || t.cantidad);
                }
            });

            const diferencia = saldoDeseado - saldoActual;

            if (diferencia === 0) {
                mensajeRespuesta = `✅ El saldo de *${cuentaObjetivo.toUpperCase()}* ya es de **$${saldoDeseado.toFixed(2)}**.\nNo se requiere ningún ajuste.`;
            } else {
                const tipoAjuste = diferencia > 0 ? 'ingreso' : 'gasto';
                const cantidadAjuste = Math.abs(diferencia);

                transaccionData = {
                    tipo: tipoAjuste,
                    cantidad: parseFloat(cantidadAjuste.toFixed(2)),
                    concepto: 'Ajuste manual de saldo',
                    cuenta: cuentaObjetivo
                };

                const iconoAjuste = diferencia > 0 ? '📈' : '📉';
                mensajeRespuesta = `✅ *SALDO ACTUALIZADO*\n🏦 Cuenta: ${cuentaObjetivo.toUpperCase()}\n💰 Nuevo saldo: *$${saldoDeseado.toFixed(2)}*\n\n_(${iconoAjuste} Ajuste interno de $${cantidadAjuste.toFixed(2)} aplicado)_`;
            }
        }

        // 💾 GUARDADO EN BASE DE DATOS
        let opcionesMensaje = { parse_mode: 'Markdown' };

        if (transaccionData) {
            nuevaTransaccion = new Transaccion(transaccionData);
            await nuevaTransaccion.save();
            
            opcionesMensaje.reply_markup = {
                inline_keyboard: [[ Markup.button.callback('❌ Borrar registro', `del_${nuevaTransaccion._id}`) ]]
            };
        }

        ctx.telegram.editMessageText(ctx.chat.id, mensajeEspera.message_id, null, mensajeRespuesta, opcionesMensaje);

    } catch (error) {
        console.error("Error procesando con IA:", error);
        ctx.telegram.editMessageText(ctx.chat.id, mensajeEspera.message_id, null, `🚨 ERROR TÉCNICO: Verifica que hayas escrito una instrucción clara.`);
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