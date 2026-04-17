const axios = require('axios');

const PHONE_ID=process.env.WHATSAPP_PHONE_ID;
const WHATSAPP_URL=process.env.WHATSAPP_URL;

const HI_MESSAGES = ['hello', 'hi', 'hey', 'hola', 'hii', 'hi there', 'hello there', 'hey there', 'hola there', 'hii there'];
const HELP_MESSAGES = ['help', 'support', 'assistance', 'need help', 'help me', 'support me', 'assistance me'];
const BYE_MESSAGES = ['bye', 'goodbye', 'see you later', 'see you soon', 'goodbye bye', 'bye bye'];
const THANK_YOU_MESSAGES = ['thank you', 'tq', 'ty', 'thanks', 'thank you very much', 'thanks a lot', 'thank you so much', 'thanks for your help'];
const TEST_MESSAGES = ['test', 'testing', 'test me', 'test me please', 'test me if you can', 'test me if you can please'];

async function sendTextMessage(msg, number) {
    const response = await axios({
        url: `${WHATSAPP_URL}/${PHONE_ID}/messages`,
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json',
        },
        data: JSON.stringify({
            messaging_product: 'whatsapp',
            to: number,
            type: 'text',
            text: { body: msg }
        })
    });
    return response.data;
}

/**
 * Send a pre-approved template message.
 * Required when the 24-hour free-form messaging window has closed.
 * @param {string} number       - Recipient phone
 * @param {string} templateName - Approved template name
 * @param {string} languageCode - BCP-47 language code (e.g. 'en')
 * @param {Array}  [components] - Optional template variable components
 */
async function sendTemplateMessage(number, templateName, languageCode = 'en', components = []) {
    const templatePayload = {
        name: templateName,
        language: { code: languageCode },
    };
    if (components.length > 0) templatePayload.components = components;

    const response = await axios({
        url: `${WHATSAPP_URL}/${PHONE_ID}/messages`,
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json',
        },
        data: JSON.stringify({
            messaging_product: 'whatsapp',
            to: number,
            type: 'template',
            template: templatePayload,
        })
    });
    return response.data;
}

async function genericMessageHandler(messages) {
    if(!messages?.text?.body || messages?.text?.body.trim() === '' || messages?.text?.body.trim() === 'null') {
       return sendTextMessage('Sorry, i did not understand your message.', messages.from);
    }
    // if it is a hi message in message text body then send a welcome message
    else if(HI_MESSAGES.includes(messages.text.body.toLowerCase().trim())) {
        return sendTextMessage('Hey, Thanks for choosing us. I am Nexo AI.', messages.from);
    }
    else if(HELP_MESSAGES.includes(messages.text.body.toLowerCase().trim())) {
        return sendTextMessage('I am here to help you. How can I assist you today?', messages.from);
    }
    else if(BYE_MESSAGES.includes(messages.text.body.toLowerCase().trim())) {
        return sendTextMessage('Goodbye! Have a great day!', messages.from);
    }
    else if(THANK_YOU_MESSAGES.includes(messages.text.body.toLowerCase().trim())) {
        return sendTextMessage('You are welcome! If you need any help, feel free to ask.', messages.from);
    }
    else if(TEST_MESSAGES.includes(messages.text.body.toLowerCase().trim())) {
        return sendTextMessage('Test message received. I am here to help you. How can I assist you today?', messages.from);
    }
    
    return false;
}

module.exports = {
    genericMessageHandler,
    sendTextMessage,
    sendTemplateMessage,
}