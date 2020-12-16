import Member from './structures/member';
import { RespondFunction } from './server';
import SlashCreator from './creator';
import {
  CommandOption,
  Endpoints,
  InteractionRequestData,
  InteractionResponseFlags,
  InterationResponseType
} from './constants';
import { formatAllowedMentions, FormattedAllowedMentions, MessageAllowedMentions } from './util';
import Message from './structures/message';

type ConvertedOption = { [key: string]: ConvertedOption } | string | number | boolean;

export interface EditMessageOptions {
  /** The message content. */
  content?: string;
  /** The embeds of the message. */
  embeds?: any[];
  /** The mentions allowed to be used in this message. */
  allowedMentions?: MessageAllowedMentions;
}

interface MessageOptions extends EditMessageOptions {
  /** Whether to use TTS for the content. */
  tts?: boolean;
  /** The flags to use in the message. */
  flags?: number;
  /**
   * Whether or not the message should be ephemeral.
   * Ignored if `flags` is defined.
   */
  ephemeral?: boolean;
  /** Whether or not to include the source of the interaction in the message. */
  includeSource?: boolean;
}

class CommandContext {
  /** The creator of the command */
  readonly creator: SlashCreator;
  /** The full interaction data */
  readonly data: InteractionRequestData;
  /** The interaction's token */
  readonly interactionToken: string;
  /** The interaction's ID */
  readonly interactionID: string;
  /** The channel ID that the command was invoked in */
  readonly channelID: string;
  /** The guild ID that the command was invoked in */
  readonly guildID: string;
  /** The member that invoked the command */
  readonly member: Member;
  /** The command's name */
  readonly commandName: string;
  /** The command's ID */
  readonly commandID: string;
  /** The options given to the command */
  readonly options?: { [key: string]: ConvertedOption };
  /** The time when the context was created */
  readonly invokedAt: number = Date.now();
  /** Whether the initial response was made */
  initiallyResponded = false;

  private _respond: RespondFunction;

  constructor(creator: SlashCreator, data: InteractionRequestData, respond: RespondFunction) {
    this.creator = creator;
    this.data = data;
    this._respond = respond;

    this.interactionToken = data.token;
    this.interactionID = data.id;
    this.channelID = data.channel_id;
    this.guildID = data.guild_id;
    this.member = new Member(data.member, this.creator);

    this.commandName = data.data.name;
    this.commandID = data.data.id;
    if (data.data.options) this.options = CommandContext.convertOptions(data.data.options);
  }

  /** Whether the interaction has expired. Interactions last 15 minutes. */
  get expired() {
    return this.invokedAt + 1000 * 60 * 15 < Date.now();
  }

  // @TODO handle this: https://get.snaz.in/AFLrDBa.png

  /**
   * Sends a message, if it already made an initial response, this will create a follow-up message.
   * This will return a boolean if it's an initial response, otherwise a {@see Message} will be returned.
   * Note that when making a follow-up message, the `ephemeral` and `includeSource` are ignored.
   * @param content The content of the message
   * @param options The message options
   */
  async send(content: string | MessageOptions, options?: MessageOptions): Promise<boolean | Message> {
    if (this.expired) throw new Error('This interaction has expired');

    if (typeof content !== 'string') options = content;
    else if (typeof options !== 'object') options = {};

    if (typeof options !== 'object') throw new Error('Message options is not an object.');

    if (!options.content) options.content = content as string;

    if (!options.content && !options.embeds) throw new Error('Message content and embeds are both not given.');

    if (options.ephemeral && !options.flags) options.flags = InteractionResponseFlags.EPHEMERAL;

    const allowedMentions = options.allowedMentions
      ? formatAllowedMentions(options.allowedMentions, this.creator.allowedMentions as FormattedAllowedMentions)
      : this.creator.allowedMentions;

    if (!this.initiallyResponded) {
      await this._respond({
        status: 200,
        body: {
          type: options.includeSource
            ? InterationResponseType.CHANNEL_MESSAGE_WITH_SOURCE
            : InterationResponseType.CHANNEL_MESSAGE,
          data: {
            tts: options.tts,
            content: options.content,
            embeds: options.embeds,
            flags: options.flags,
            allowed_mentions: allowedMentions
          }
        }
      });
      this.initiallyResponded = true;
      return true;
    } else {
      const data = await this.creator.requestHandler.request(
        'POST',
        Endpoints.FOLLOWUP_MESSAGE(this.creator.options.applicationID, this.interactionToken),
        true,
        {
          tts: options.tts,
          content: options.content,
          embeds: options.embeds,
          allowed_mentions: allowedMentions
        }
      );
      return new Message(data, this);
    }
  }

  /**
   * Edits a message.
   * @param messageID The message's ID
   * @param content The content of the message
   * @param options The message options
   */
  async edit(messageID: string, content: string | EditMessageOptions, options?: EditMessageOptions) {
    if (this.expired) throw new Error('This interaction has expired');

    if (typeof content !== 'string') options = content;
    else if (typeof options !== 'object') options = {};

    if (typeof options !== 'object') throw new Error('Message options is not an object.');

    if (!options.content) options.content = content as string;

    if (!options.content && !options.embeds && !options.allowedMentions)
      throw new Error('No valid options were given.');

    const allowedMentions = options.allowedMentions
      ? formatAllowedMentions(options.allowedMentions, this.creator.allowedMentions as FormattedAllowedMentions)
      : this.creator.allowedMentions;

    const data = await this.creator.requestHandler.request(
      'PUT',
      Endpoints.MESSAGE(this.creator.options.applicationID, this.interactionToken, messageID),
      true,
      {
        content: options.content,
        embeds: options.embeds,
        allowed_mentions: allowedMentions
      }
    );
    return new Message(data, this);
  }

  /**
   * Edits the original message.
   * @param content The content of the message
   * @param options The message options
   */
  editOriginal(content: string | EditMessageOptions, options?: EditMessageOptions) {
    return this.edit('@original', content, options);
  }

  /**
   * Deletes a message. If the message ID was not defined, the original message is used.
   * @param messageID The message's ID
   */
  async delete(messageID?: string) {
    if (this.expired) throw new Error('This interaction has expired');

    return this.creator.requestHandler.request(
      'DELETE',
      Endpoints.MESSAGE(this.creator.options.applicationID, this.interactionToken, messageID)
    );
  }

  /**
   * Acknowleges the interaction. Including source will send a message showing only the source.
   * @param includeSource Whether to include the source in the acknolegement.
   * @returns Whether the acknowledgement passed
   */
  async acknowledge(includeSource = false): Promise<boolean> {
    if (!this.initiallyResponded) {
      await this._respond({
        status: 200,
        body: {
          type: includeSource ? InterationResponseType.ACKNOWLEDGE_WITH_SOURCE : InterationResponseType.ACKNOWLEDGE
        }
      });
      this.initiallyResponded = true;
      return true;
    }

    return false;
  }

  /** @private */
  static convertOptions(options: CommandOption[]) {
    const convertedOptions: { [key: string]: ConvertedOption } = {};
    for (const option of options) {
      if (option.options) convertedOptions[option.name] = CommandContext.convertOptions(option.options);
      else if (option.value) convertedOptions[option.name] = option.value;
    }
    return convertedOptions;
  }
}

export default CommandContext;
