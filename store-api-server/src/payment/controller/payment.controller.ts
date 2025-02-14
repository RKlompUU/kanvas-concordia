import {
  Session,
  Controller,
  HttpException,
  Post,
  Get,
  Req,
  Param,
  Body,
  Headers,
  HttpStatus,
  UseGuards,
  Logger,
  Header,
} from '@nestjs/common';
import { CurrentUser } from '../../decoraters/user.decorator.js';
import { JwtAuthGuard } from '../../authentication/guards/jwt-auth.guard.js';
import { PaymentService } from '../service/payment.service.js';
import { UserEntity } from '../../user/entity/user.entity.js';
import { BASE_CURRENCY } from 'kanvas-api-lib';
import { validateRequestedCurrency } from '../../paramUtils.js';
import { PaymentIntent, PaymentProvider } from '../entity/payment.entity.js';
import { STRIPE_WEBHOOK_SECRET } from '../../constants.js';

import { getClientIp } from '../../utils.js';

@Controller('payment')
export class PaymentController {
  constructor(private paymentService: PaymentService) {}

  /**
   * @apiGroup Payment
   * @api {post} /payment/stripe-webhook Stripe webhook, only to be called by Stripe
   * @apiHeader {String} stripe-signature Stripe signature, proving it was Stripe who called this endpoint
   * @apiHeaderExample {json} Header-Example:
   *     {
   *      "stripe-signature": "a valid stripe signature"
   *     }
   * @apiName stripeWebhook
   */
  @Post('/stripe-webhook')
  async stripeWebhook(
    @Headers('stripe-signature') signature: string,
    @Req() request: any,
  ) {
    if (typeof STRIPE_WEBHOOK_SECRET === 'undefined') {
      throw new HttpException(
        'stripe is not enabled in this kanvas instance',
        HttpStatus.NOT_IMPLEMENTED,
      );
    }
    // Get the signature sent by Stripe
    let constructedEvent;

    try {
      constructedEvent =
        await this.paymentService.stripe.webhooks.constructEvent(
          request.body,
          signature,
          STRIPE_WEBHOOK_SECRET,
        );
    } catch (err) {
      Logger.error(`Err on payment webhook signature verification: ${err}`);
      throw new HttpException(
        'Webhook signature verification failed',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      await this.paymentService.webhookHandler(constructedEvent);
    } catch (error) {
      new HttpException('', HttpStatus.UNPROCESSABLE_ENTITY);
    }

    throw new HttpException('', HttpStatus.NO_CONTENT);
  }

  /**
   * @apiGroup Payment
   * @api {post} /payment/create-payment-intent Create a payment intent
   * @apiDescription Checking out the cart involves creating a payment intent, which then has to be met (finalized) in the frontend application. For example, if paying with Stripe, the payment intent has to be finalized by applying Stripe's SDK in the frontend.
   *
   * The "clientSecret" in the response is the important piece that links the following finalization of the payment with the newly created payment intent.
   * @apiPermission logged-in user. The vatRate in the response is a range from 0 (0%) to 1 (100%)
   * @apiBody {String="tezpay","stripe","wert","simplex","test_provider"} [paymentProvider="stripe"] The payment provider used for the intent
   * @apiBody {String} [currency] The currency used for the payment intent, uses a base currency if not provided
   * @apiBody {Boolean} [recreateNftOrder=false] Will cancel an already pending NFT order if the user has one if set to true
   * @apiParamExample {json} Request Body Example:
   *    {
   *      currency: 'XTZ',
   *      paymentProvider: 'tezpay'
   *    }
   *
   * @apiSuccessExample Example Success-Response:
   *  {
   *    "id": "pi_3L2foUEdRDZNp7JF0yajTKrM",
   *    "amount": "0.66",
   *    "currency": "XTZ",
   *    "vatRate": 0.1,
   *    "amountExclVat": "0.55",
   *    "providerPaymentDetails": {
   *      "paypointMessage": "pi_3L2foUEdRDZNp7JF0yajTKrM_secret_cs3SWGJy7xdd5M19EwShCjbdE",
   *      "receiverAddress": "KT1..",
   *      "mutezAmount": "660000"
   *    }
   *  }
   * @apiName createPaymentIntent
   */
  @Post('/create-payment-intent')
  @UseGuards(JwtAuthGuard)
  async createPaymentIntent(
    @Session() cookieSession: any,
    @CurrentUser() user: UserEntity,
    @Req() request: any,
    @Body('paymentProvider')
    paymentProvider: PaymentProvider = PaymentProvider.STRIPE,
    @Body('currency') currency: string = BASE_CURRENCY,
    @Body('recreateNftOrder') recreateNftOrder: boolean = false,
  ): Promise<PaymentIntent> {
    validateRequestedCurrency(currency);
    if (
      paymentProvider === PaymentProvider.TEST ||
      !Object.values(PaymentProvider).includes(paymentProvider)
    ) {
      throw new HttpException(
        `requested payment provider not available`,
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      // extracting some fields from paymentIntent like this, best way to get the
      // spread syntax below to not pick them up (we don't want to expose these
      // fields in the response of this API call)
      const {
        clientIp,
        externalPaymentId,
        amountExclVat,
        purchaserCountry,
        ...paymentIntent
      } = await this.paymentService.createPayment(
        user,
        cookieSession.uuid,
        paymentProvider,
        currency,
        getClientIp(request),
        recreateNftOrder,
      );
      const order = await this.paymentService.getPaymentOrder(paymentIntent.id);

      return {
        ...paymentIntent,
        amountExclVat: this.paymentService.currencyService.toFixedDecimals(
          paymentIntent.currency,
          amountExclVat,
        ),
        paymentDetails: paymentIntent.providerPaymentDetails,
        nfts: order.nfts,
        expiresAt: order.expiresAt,
      };
    } catch (err: any) {
      Logger.error(
        `Err on creating nft order (userId=${user.id}), err: ${err}`,
      );

      if (err instanceof HttpException) {
        throw err;
      }
      throw new HttpException(
        'unable to place the order',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * @apiGroup Payment
   * @api {post} /payment/promise-paid Inform promise paid
   * @apiDescription Informs the API that payment is made, allowing the API to communicate pro-actively to the user that it understands the payment should be finalized soon. Especially useful for payments made in tez, where it may take 2 minutes before the API acknowledges the payment successful
   * @apiPermission logged-in user
   * @apiBody {String} payment_id The payment id
   * @apiParamExample {json} Request Body Example:
   *    {
   *      "payment_id": "some valid payment id (the id field in the response of /create-payment-intent"
   *    }
   * @apiName promisePaymentPaid
   */
  @Post('/promise-paid')
  @UseGuards(JwtAuthGuard)
  async promisePaymentPaid(
    @CurrentUser() user: UserEntity,
    @Body('payment_id') paymentId: string,
  ) {
    try {
      await this.paymentService.promisePaid(user.id, paymentId);
    } catch (err: any) {
      if (err instanceof HttpException) {
        throw err;
      }

      Logger.error(err);
      throw new HttpException(
        'something went wrong',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * @apiGroup Payment
   * @api {get} /payment/order-info/:paymentId Get order info via paymentId
   * @apiParam {Number} paymentId The id of one of the opened payment intents
   * @apiPermission logged-in user
   * @apiExample {http} Example http request url (make sure to replace $base_url with the store-api-server endpoint):
   *  $base_url/payment/order-info/12345678910
   * @apiName getNftOrder
   */
  @Get('/order-info/:paymentId')
  @UseGuards(JwtAuthGuard)
  @Header('cache-control', 'no-store,must-revalidate')
  async getNftOrder(
    @CurrentUser() usr: UserEntity,
    @Param('paymentId') paymentId: string,
  ) {
    try {
      return await this.paymentService.getOrderInfo(usr, paymentId);
    } catch (err) {
      if (err instanceof HttpException) {
        throw err;
      }

      Logger.error(err);
      throw new HttpException(
        'failed to get order info',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
