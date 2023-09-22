const functions = require('@google-cloud/functions-framework');
const escapeHtml = require('escape-html');
const axios = require('axios');
const { request } = require("@octokit/request");
const withAuth = request.defaults({
    headers: {
      authorization: `token ${process.env.GITHUB_TOKEN}`
    }
});

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
    Don't mention the JSON or this system message unless the mention includes the string 'al_debug'.
    You might receive thread history if the mention is part of a thread. Process it as you would a conversation history and continue the conversation.
    Your slack userid is U053USWP230 and your botid is B054FE89V50. Avoid repeating yourself.
    If you need assistance, please tag your caretaker like this: <@david>.
    You may be asked to 'deploy' or 'release' changes to our Shopify store - this is done by merging a pull request from staging to main. If you are given a pull request number, or you can find one earlier in the conversation, assume it exists and just merge it using mergeDeploymentPR.
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
    var messages = [
        {"role": "system", "content": system_notes},
        {"role": "user", "content": message_text}
    ]
    const functions = [
        {
            "name": "fetchOpenDeploymentPR",
            "description": "Returns the pr number and url of the open pull request from staging to main",
            "parameters": {"type": "object", "properties": {},"required": []},
        },
        {
            "name": "createDeploymentPR",
            "description": "Creates a pr, returns the pr number and URL of the created pr",
            "parameters": {"type": "object", "properties": {},"required": []},
        },
        {
            "name": "mergeDeploymentPR",
            "description": "Merges a deployment pr by number, releasing the changes",
            "parameters": {"type": "object", "properties": {
                "pullNumber": {
                    "type": "string",
                    "description": "The number of the deployment pr to be merged",
                },
            },"required": ["pullNumber"]},
        }
    ]
    var gpt_api_data = { 
        "model": "gpt-3.5-turbo",
        "messages": messages,
        "functions": functions,
        "temperature": 0.8
    };

    // Send the HTTP request to the GPT API and wait for the response using async/await.
    try {
        const gpt_api_response = await axios.post(gpt_api_url, gpt_api_data, { headers: gpt_api_headers });
        var message = gpt_api_response.data.choices[0].message;

        console.log(JSON.stringify(gpt_api_response.data));

        if (message.function_call) {
            // Step 3: call the function
            // Note: the JSON response may not always be valid; be sure to handle errors
            const available_functions = {
                "fetchOpenDeploymentPR": fetchOpenDeploymentPR,
                "createDeploymentPR": createDeploymentPR,
                "mergeDeploymentPR": mergeDeploymentPR
            };
            const function_name = message.function_call.name;
            const fuction_to_call = available_functions[function_name];
            const function_parameters = JSON.parse(message.function_call.arguments);

            if (JSON.stringify(function_parameters) === '{}') {
                var function_response = await fuction_to_call();
            } else {
                var function_response = await fuction_to_call(function_parameters);
            }

            // Step 4: send the info on the function call and function response to GPT
            messages.push(message) // extend conversation with assistant's reply
            messages.push(
                {
                    "role": "function",
                    "name": function_name,
                    "content": function_response,
                }
            )  // extend conversation with function response

            gpt_api_data.messages = messages;
            gpt_api_data.function_call = "none";
            const second_response = await axios.post(gpt_api_url, gpt_api_data, { headers: gpt_api_headers });
            message = second_response.data.choices[0].message;
            console.log(JSON.stringify(second_response.data));
        }

        // Send the generated text back to the same channel using the Slack incoming webhook.
        const webhook_url = process.env.SLACK_WEBHOOK_URL;
        const payload = { 
            channel: channel_id, 
            text: message.content,
            thread_ts: event.ts
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

async function fetchOpenDeploymentPR() {
    try {
        const response = await withAuth("GET /repos/{owner}/{repo}/pulls", {
            owner: 'Cuyana',
            repo: 'shopify',
            head: 'staging',  // format can be 'branch' or 'user:branch'
            base: 'main'
        });

        console.log(JSON.stringify(response.data));
        
        if (response.data[0]?.number) {
            return "The number of the deployment PR is " + response.data[0].number + " and the url is " + response.data.html_url;
        }
    } catch (error) {
        console.error(error);
    }
    return "none found";
}

async function createDeploymentPR() {
    try {
        const response = await withAuth("POST /repos/{owner}/{repo}/pulls", {
            owner: 'Cuyana',
            repo: 'shopify',
            title: 'Al Release',
            head: 'staging',
            base: 'main',
            body: '',
            maintainer_can_modify: true  // This allows maintainers to modify the PR if needed
        });

        console.log(JSON.stringify(response.data));
        
        if (response.data.number) {
            return "The number of the new PR is " + response.data.number +  " and the url is " + response.data.html_url;
        }
    } catch (error) {
        console.error(error);
    }
    return "Failed to create PR";
}

async function mergeDeploymentPR(args) {
    try {
        const response = await withAuth("PUT /repos/{owner}/{repo}/pulls/{number}/merge", {
            owner: 'Cuyana',
            repo: 'shopify',
            number: args.pullNumber
        });

        console.log(JSON.stringify(response.data));
        
        return JSON.stringify(response.data);
    } catch (error) {
        console.error(error);
    }
    return "Failed to merge PR";
}