const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config/config.json');
const { createFeedbackResponseEmbed, createAdminReplyEmbed } = require('./embedUtils');
const { hashUserId } = require('./cryptoUtils');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

const dbPath = path.join(__dirname, '..', '..', 'data', 'bot.sqlite');
const db = new sqlite3.Database(dbPath);

let ENCRYPTION_KEY = config.encryptionKey;
const IV_LENGTH = 16;

function generateEncryptionKey() {
  return crypto.randomBytes(32).toString('hex');
}

if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 64) {
  console.warn('ENCRYPTION_KEY is not set or invalid in config.json. Generating a new 32-byte encryption key.');
  ENCRYPTION_KEY = generateEncryptionKey();
  console.log('New ENCRYPTION_KEY:', ENCRYPTION_KEY);
  console.log('Please add this key to your config.json file for future use.');
}

const userIdCache = new Map();

//definitely not copied encryption code character for character
function encryptUserId(userId) {
  try {
    const iv = crypto.createHash('md5').update(userId).digest().slice(0, 16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
    let encrypted = cipher.update(userId);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
  } catch (error) {
    console.error('Error encrypting user ID:', error);
    throw new Error('Failed to encrypt user ID');
  }
}

function decryptUserId(encryptedId) {
  try {
    const textParts = encryptedId.split(':');
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  } catch (error) {
    console.error('Error decrypting user ID:', error);
    throw new Error('Failed to decrypt user ID');
  }
}
//

function createFeedbackModal(type) {
  const modal = new ModalBuilder()
    .setCustomId(`feedback_modal_${type}`)
    .setTitle(type === 'server' ? 'Submit Server Feedback' : 'Submit Player Report');

  const feedbackInput = new TextInputBuilder()
    .setCustomId('feedback_input')
    .setLabel(type === 'server' ? 'Your feedback' : 'Your report')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true);

  const optInInput = new TextInputBuilder()
    .setCustomId('opt_in_input')
    .setLabel('Do you opt in to replies? (Y/N)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const firstActionRow = new ActionRowBuilder().addComponents(feedbackInput);
  const secondActionRow = new ActionRowBuilder().addComponents(optInInput);

  modal.addComponents(firstActionRow, secondActionRow);

  return modal;
}

async function handleFeedbackSubmission(interaction, type) {
  const modal = createFeedbackModal(type);
  await interaction.showModal(modal);
}

async function handleFeedbackModalSubmit(interaction, client, type) {
    try {
      const feedback = interaction.fields.getTextInputValue('feedback_input');
      const optIn = interaction.fields.getTextInputValue('opt_in_input').toLowerCase();
      const feedbackId = Date.now().toString();
      
      const isOptIn = ['y', 'yes'].includes(optIn);
      
      const { embed, components } = createFeedbackResponseEmbed(type, feedbackId, isOptIn);
      embed.setDescription(feedback);
  
      const feedbackChannelId = config.feedbackChannel;
      const feedbackChannel = await client.channels.fetch(feedbackChannelId);
  
      if (feedbackChannel) {
        const messageOptions = { embeds: [embed] };
        if (isOptIn) {
          messageOptions.components = components;
        }
        const message = await feedbackChannel.send(messageOptions);
        
        // stores feedback in the database, only including user ID if opted in
        let dbData = [feedbackId, type, feedback, isOptIn ? 1 : 0, message.id];
        let dbFields = 'feedback_id, type, content, opt_in, message_id';
        let dbPlaceholders = '?, ?, ?, ?, ?';
        
        if (isOptIn) {
          const encryptedUserId = encryptUserId(interaction.user.id);
          dbData.unshift(encryptedUserId);
          dbFields = 'encrypted_user_id, ' + dbFields;
          dbPlaceholders = '?, ' + dbPlaceholders;
        }
        
        db.run(`INSERT INTO feedback (${dbFields}) VALUES (${dbPlaceholders})`, dbData, (err) => {
          if (err) {
            console.error('Error storing feedback:', err);
          } else if (isOptIn) {
            userIdCache.set(feedbackId, interaction.user.id);
          }
        });
        
        await interaction.reply({ content: 'Your feedback has been submitted anonymously.', ephemeral: true });
      } else {
        console.error('Feedback channel not found');
        await interaction.reply({ content: 'There was an error submitting your feedback. Please try again later.', ephemeral: true });
      }
    } catch (error) {
      console.error('Error handling feedback submission:', error);
      await interaction.reply({ content: 'An error occurred while processing your feedback. Please try again later.', ephemeral: true });
    }
  }

async function handleAdminReply(interaction) {
  const feedbackId = interaction.customId.split('_')[2];

  const modal = new ModalBuilder()
    .setCustomId(`admin_reply_modal_${feedbackId}`)
    .setTitle('Reply to Feedback');

  const replyInput = new TextInputBuilder()
    .setCustomId('reply_input')
    .setLabel('Your reply')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true);

  const firstActionRow = new ActionRowBuilder().addComponents(replyInput);
  modal.addComponents(firstActionRow);

  await interaction.showModal(modal);
}

async function handleAdminReplySubmit(interaction, client) {
  const reply = interaction.fields.getTextInputValue('reply_input');
  const feedbackId = interaction.customId.split('_')[3];

  db.get('SELECT encrypted_user_id, opt_in FROM feedback WHERE feedback_id = ?', [feedbackId], async (err, row) => {
    if (err) {
      console.error('Error fetching feedback data:', err);
      await interaction.reply({ content: 'An error occurred while processing your reply.', ephemeral: true });
      return;
    }

    if (!row) {
      await interaction.reply({ content: 'Unable to find the feedback.', ephemeral: true });
      return;
    }

    const { encrypted_user_id, opt_in } = row;

    db.run('INSERT INTO admin_replies (feedback_id, reply_content) VALUES (?, ?)',
      [feedbackId, reply],
      async (err) => {
        if (err) {
          console.error('Error storing admin reply:', err);
          await interaction.reply({ content: 'An error occurred while storing your reply.', ephemeral: true });
          return;
        }

        if (opt_in) {
          await interaction.channel.send(`<@${interaction.user.id}> replied to feedback id \`${feedbackId}\` with\n> ${reply}`);
        }

        if (opt_in) {
          let userId;
          if (userIdCache.has(feedbackId)) {
            userId = userIdCache.get(feedbackId);
          } else {
            userId = decryptUserId(encrypted_user_id);
            userIdCache.set(feedbackId, userId);
          }

          try {
            const user = await client.users.fetch(userId);
            await user.send({ content: `An admin has replied to your feedback (ID: ${feedbackId}). You can reply using \`!reply <your message>\`.\n\nAdmin's reply:\n> ${reply}` });
            await interaction.reply({ content: 'Reply sent successfully to the user.', ephemeral: true });
          } catch (error) {
            console.error('Error sending DM:', error);
            await interaction.reply({ content: 'Unable to send DM to the user. They may have DMs disabled or have left the server.', ephemeral: true });
          }
        } else {
          await interaction.reply({ content: 'User opted out of receiving replies. Reply not sent.', ephemeral: true });
        }
      }
    );
  });
}

async function handleUserReply(message, client) {
  if (!message.guild) {
    const userId = message.author.id;
    const reply = message.content.slice(7).trim();
    const feedbackChannelId = config.feedbackChannel;
    const feedbackChannel = await client.channels.fetch(feedbackChannelId);

    if (!feedbackChannel) {
      await message.author.send('There was an error processing your reply. Please try again later.');
      return;
    }

    const encryptedUserId = encryptUserId(userId);

    try {
      const row = await new Promise((resolve, reject) => {
        db.get('SELECT feedback_id, message_id FROM feedback WHERE encrypted_user_id = ? ORDER BY created_at DESC LIMIT 1', 
          [encryptedUserId], 
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });

      if (!row) {
        await message.author.send('No recent feedback found to reply to. If you\'ve received a reply from an admin, there might be an issue with our system. Please submit new feedback or contact a server administrator.');
        return;
      }

      const { feedback_id, message_id } = row;
      const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('User Reply to Feedback')
        .setDescription(reply)
        .setFooter({ text: `Feedback ID: ${feedback_id}` })
        .setTimestamp();

      const replyButton = new ButtonBuilder()
        .setCustomId(`reply_user_feedback_${feedback_id}`)
        .setLabel('Reply')
        .setStyle(ButtonStyle.Primary);

      const actionRow = new ActionRowBuilder().addComponents(replyButton);

      const originalMessageLink = `https://discord.com/channels/${feedbackChannel.guild.id}/${feedbackChannel.id}/${message_id}`;

      await feedbackChannel.send({ 
        content: `Original Feedback: ${originalMessageLink}`,
        embeds: [embed],
        components: [actionRow]
      });

      await message.author.send('Your reply has been sent anonymously to the admin team.');

    } catch (error) {
      console.error('Error handling user reply:', error);
      await message.author.send('An error occurred while processing your reply. Please try again later.');
    }
  }
}

async function handleAdminReplyToUserReply(interaction) {
  const feedbackId = interaction.customId.split('_')[3];

  const modal = new ModalBuilder()
    .setCustomId(`admin_reply_user_modal_${feedbackId}`)
    .setTitle('Reply to User Feedback');

  const replyInput = new TextInputBuilder()
    .setCustomId('reply_input')
    .setLabel('Your reply')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true);

  const firstActionRow = new ActionRowBuilder().addComponents(replyInput);
  modal.addComponents(firstActionRow);

  await interaction.showModal(modal);
}

async function handleAdminReplyToUserReplySubmit(interaction, client) {
  const reply = interaction.fields.getTextInputValue('reply_input');
  const feedbackId = interaction.customId.split('_')[4];

  try {
    const row = await new Promise((resolve, reject) => {
      db.get('SELECT encrypted_user_id, opt_in FROM feedback WHERE feedback_id = ?', [feedbackId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!row) {
      await interaction.reply({ content: 'Unable to find the feedback.', ephemeral: true });
      return;
    }

    const { encrypted_user_id, opt_in } = row;

    await interaction.channel.send(`<@${interaction.user.id}> replied to feedback id \`${feedbackId}\` with\n> ${reply}`);

    if (opt_in) {
      let userId = decryptUserId(encrypted_user_id);
      try {
        const user = await client.users.fetch(userId);
        await user.send({ content: `An admin has replied to your feedback (ID: ${feedbackId}). You can reply using \`!reply <your message>\`.\n\nAdmin's reply:\n> ${reply}` });
        await interaction.reply({ content: 'Reply sent successfully to the user and posted in the channel.', ephemeral: true });
      } catch (error) {
        console.error('Error sending DM:', error);
        await interaction.reply({ content: 'Unable to send DM to the user. They may have DMs disabled or have left the server.', ephemeral: true });
      }
    } else {
      await interaction.reply({ content: 'User opted out of receiving replies. Reply not sent.', ephemeral: true });
    }

    await new Promise((resolve, reject) => {
      db.run('INSERT INTO admin_replies (feedback_id, reply_content) VALUES (?, ?)',
        [feedbackId, reply],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

  } catch (error) {
    console.error('Error in handleAdminReplyToUserReplySubmit:', error);
    await interaction.reply({ content: 'An error occurred while processing your reply.', ephemeral: true });
  }
}

async function handleViewReplies(message, client) {
  const hashedUserId = hashUserId(message.author.id);

  db.all('SELECT f.feedback_id, f.type, f.content, ar.reply_content FROM feedback f LEFT JOIN admin_replies ar ON f.feedback_id = ar.feedback_id WHERE f.hashed_user_id = ?', [hashedUserId], async (err, rows) => {
    if (err) {
      console.error('Error fetching replies:', err);
      await message.reply('An error occurred while fetching your replies.');
      return;
    }

    if (rows.length === 0) {
      await message.reply('You have no feedback or replies to view.');
      return;
    }

    for (const row of rows) {
      const embed = new EmbedBuilder()
        .setTitle(`Your ${row.type} Feedback`)
        .setDescription(row.content)
        .setColor('#3498db');

      if (row.reply_content) {
        embed.addFields({ name: 'Admin Reply', value: row.reply_content });
      }

      await message.author.send({ embeds: [embed] });
    }

    await message.reply('I\'ve sent you a DM with your feedback and any replies.');
  });
}

module.exports = {
  handleFeedbackSubmission,
  handleFeedbackModalSubmit,
  handleAdminReply,
  handleAdminReplySubmit,
  handleUserReply,
  handleAdminReplyToUserReply,
  handleAdminReplyToUserReplySubmit,
  handleViewReplies
};
