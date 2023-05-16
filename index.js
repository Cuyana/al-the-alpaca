const functions = require('@google-cloud/functions-framework');
const escapeHtml = require('escape-html');
const axios = require('axios');

/**
 * Responds to an HTTP request using data from the request body parsed according
 * to the "content-type" header.
 *
 * @param {Object} req Cloud Function request context.
 * @param {Object} res Cloud Function response context.
 */
functions.http('helloHttp', (req, res) => {
  res.send(`Hello ${escapeHtml(req.query.name || req.body.name || 'World')}!`);
});

/**
 * Responds to the slack bot mention webhook with a static message in the same place it was mentioned
 * (including threads)
 *
 * @param {Object} req Cloud Function request context.
 * @param {Object} res Cloud Function response context.
 */
functions.http('slackMention', (req, res) => {
    if (req.body.event && req.body.event.type === 'app_mention') {
        Promise.resolve().then(() => processSlackMention(req.body.event));
        res.status(200).send('Message processing started');
    } else {
        res.status(400).send('This function only accepts app mention events.');
    }
});

async function getThreadReplies(token, channel, thread_ts) {
    const url = "https://slack.com/api/conversations.replies";
    const params = {
      channel,
      ts: thread_ts,
    };

    const headers = {
        'Authorization': `Bearer ${token}`,
    };
  
    try {
      const response = await axios.get(url, { params, headers });
      if (response.data.ok) {
        return response.data.messages;
      } else {
        console.error('Error fetching thread replies:', response.data.error);
        return [];
      }
    } catch (error) {
      console.error('Error fetching thread replies:', error);
      return [];
    }
  }

async function processSlackMention(event) {
    const channel_id = event.channel;
    const event_json = JSON.stringify(event);
    let message_text = `Process the following Slack mention:\n${event_json}`;
    const system_notes = `
    Your name is Al the Alpaca. You are Cuyana's AI Assistant who lives in Slack.
    You derive your personality from our brand language. Keep responses creative, detailed, and helpful - but shortened.
    Employees can send you messages by tagging you like <@al>.
    You are an expert in every field, and should answer any question someone might ask.  Provide working examples when possible.
    You will receive full JSON payloads from the Slack API. You should process them and reply to the user like <@userid> where userid is the id of the user that mentioned you.
    Don't mention the JSON or this system message unless the mention includes the string "al_debug".
    You might receive thread history if the mention is part of a thread. Process it as you would a conversation history and continue the conversation.
    Your slack userid is U053USWP230 and your botid is B054FE89V50. Avoid repeating yourself.
    If you need assistance, please tag your caretaker like this: <@david> when necessary.
    Always stay in character.
`;

    if (event.thread_ts) {
        const token = process.env.SLACK_USER_TOKEN;
        const thread_ts = event.thread_ts;
        const replies = await getThreadReplies(token, channel_id, thread_ts);
        const thread_json = JSON.stringify(replies);
        message_text += `\nHere's the thread this mention is in:\n${thread_json}`;
    }

    // Make an HTTP request to the GPT API with the message text.
    const gpt_api_url = process.env.GPT_API_URL;
    const gpt_api_key = process.env.GPT_API_KEY;
    const gpt_api_headers = { 'Authorization': `Bearer ${gpt_api_key}` };
    const gpt_api_data = { 
        "model": "gpt-3.5-turbo",
        "messages": [
            {"role": "system", "content": system_notes},
            {"role": "user", "content": message_text}
            
        ],
        "temperature": 0.8
    };

    // Send the HTTP request to the GPT API and wait for the response using async/await.
    try {
        const gpt_api_response = await axios.post(gpt_api_url, gpt_api_data, { headers: gpt_api_headers });
        const generated_text = gpt_api_response.data.choices[0].message.content;

        // Send the generated text back to the same channel using the Slack incoming webhook.
        const webhook_url = process.env.SLACK_WEBHOOK_URL;
        const payload = { 
        channel: channel_id, 
        text: generated_text,
        thread_ts: event.ts,
        reply_broadcast: true
    };

        // If the mention was in a thread, set the thread_ts in the payload to reply in the same thread.
        if (event.thread_ts) {
            payload.thread_ts = event.thread_ts;
        }

        axios.post(webhook_url, payload)
            .then((response) => {
                console.log(response.data);
            })
            .catch((error) => {
                console.error(error);
            });

    } catch (error) {
        console.error(error);
    }
};