# Telegram Bot API Reference - February 2026

This document provides a comprehensive list of Telegram Bot API methods for use by an AI coding agent. Methods are categorized by functionality.

---

## 🛠 Core & Connection
* **getMe**: Test bot token and get basic bot information.
* **getUpdates**: Retrieve incoming updates using long polling.
* **setWebhook**: Specify a URL to receive incoming updates via an outgoing webhook.
* **deleteWebhook**: Remove webhook integration.
* **getWebhookInfo**: Get current webhook status.

---

## 💬 Messaging & Media
* **sendMessage**: Send text messages (supports MarkdownV2/HTML).
* **sendMessageDraft**: Stream partial messages to a user during generation (API 9.3+).
* **forwardMessage**: Forward messages of any kind.
* **copyMessage**: Copy messages without a link to the original.
* **sendPhoto / sendAudio / sendDocument / sendVideo**: Send specific media types.
* **sendAnimation**: Send GIFs or soundless MP4s.
* **sendVoice / sendVideoNote**: Send voice messages or round video notes.
* **sendPaidMedia**: Send media that requires Telegram Stars to view.
* **sendMediaGroup**: Send an album of up to 10 media items.
* **sendLocation / sendVenue / sendContact**: Send geographical or contact data.
* **sendPoll / sendDice**: Send interactive polls or animated dice.
* **sendChatAction**: Show status (e.g., "typing", "uploading photo").

---

## ✏️ Message Management
* **editMessageText / editMessageCaption**: Modify existing text/captions.
* **editMessageMedia**: Change the media attached to a message.
* **editMessageReplyMarkup**: Update inline keyboards only.
* **stopPoll**: Stop a bot-sent poll.
* **deleteMessage / deleteMessages**: Remove one or multiple messages.
* **setMessageReaction**: Add emoji reactions to a message.

---

## 🌐 Mini Apps & Web Apps
* **answerWebAppQuery**: Set the result of an interaction in a Web App.
* **savePreparedInlineMessage**: Prepare a message to be sent via a Mini App.
* **setChatMenuButton**: Change the bot's menu button for a specific chat.
* **getChatMenuButton**: Retrieve the current menu button.

---

## 👥 Chat & Member Administration
* **banChatMember / unbanChatMember**: Manage user access.
* **restrictChatMember**: Mute or restrict permissions for a user.
* **promoteChatMember**: Update admin privileges.
* **setChatPermissions**: Set global permissions for a group.
* **createChatInviteLink / editChatInviteLink**: Manage entry links.
* **setChatTitle / setChatPhoto / deleteChatPhoto**: Update chat branding.
* **pinChatMessage / unpinChatMessage**: Manage pinned content.
* **leaveChat**: Bot leaves a group or channel.
* **getChat / getChatAdministrators / getChatMemberCount**: Retrieve chat metadata.

---

## 🤖 Bot Profile & Commands
* **setMyCommands / getMyCommands / deleteMyCommands**: Manage the `/` command menu.
* **setMyName / getMyName**: Update the bot's display name.
* **setMyDescription / setMyShortDescription**: Manage "About" and "What can this bot do?" text.
* **setMyProfilePhoto / removeMyProfilePhoto**: Manage the bot's own avatar (API 9.4+).

---

## 🏷 Stickers & Inline Mode
* **sendSticker / getStickerSet**: Handle sticker delivery and metadata.
* **answerInlineQuery**: Send results back for an inline request (e.g., `@bot query`).
* **answerCallbackQuery**: Respond to button clicks on inline keyboards.

---

## 💰 Payments & Stars
* **sendInvoice / createInvoiceLink**: Initiate payment requests.
* **answerShippingQuery / answerPreCheckoutQuery**: Handle payment flow.
* **refundStarPayment**: Refund transactions made with Telegram Stars.
* **getMyStarBalance**: Check the bot's current Stars.

---

## 📂 Implementation Notes
- **Endpoint**: `https://api.telegram.org/bot<token>/<method>`
- **Content-Type**: `application/json` or `multipart/form-data` (for file uploads).
- **Response**: All responses are JSON with an `ok` boolean.