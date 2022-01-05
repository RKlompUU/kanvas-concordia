import {
  Controller,
  HttpException,
  Post,
  Req,
  Headers,
  HttpStatus,
  UseGuards,
  Logger,
} from '@nestjs/common';
import { CurrentUser } from 'src/decoraters/user.decorator';
import { JwtAuthGuard } from 'src/authentication/guards/jwt-auth.guard';
import {
  PaymentService,
  PaymentStatus,
  StripePaymentIntent,
} from 'src/payment/service/payment.service';
import { UserService } from 'src/user/service/user.service';
import { UserEntity } from 'src/user/entity/user.entity';
import { Lock } from 'async-await-mutex-lock';

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

@Controller('payment')
export class PaymentController {
  nftLock: Lock<number>;

  constructor(
    private userService: UserService,
    private paymentService: PaymentService,
  ) {}

  @Post('/stripe-webhook')
  async stripeWebhook(
    @Headers('stripe-signature') signature: string,
    @Req() request: any,
  ) {
    if (!endpointSecret) {
      throw new HttpException('Stripe not enabled', HttpStatus.BAD_REQUEST);
    }
    // Get the signature sent by Stripe
    let constructedEvent;

    try {
      constructedEvent =
        await this.paymentService.stripe.webhooks.constructEvent(
          request.body,
          signature,
          endpointSecret,
        );
    } catch (err) {
      Logger.error(`Err on payment webhook signature verification: ${err}`);
      throw new HttpException(
        'Webhook signature verification failed',
        HttpStatus.BAD_REQUEST,
      );
    }

    let paymentStatus: PaymentStatus;

    switch (constructedEvent.type) {
      case 'payment_intent.succeeded':
        paymentStatus = PaymentStatus.SUCCEEDED;
        break;
      case 'payment_intent.processing':
        paymentStatus = PaymentStatus.PROCESSING;
        break;
      case 'payment_intent.canceled':
        paymentStatus = PaymentStatus.CANCELED;
        console.log('cancelled');
        break;
      case 'payment_intent.payment_failed':
        paymentStatus = PaymentStatus.FAILED;
        break;
      default:
        Logger.error(`Unhandled event type ${constructedEvent.type}`);
        throw new HttpException('', HttpStatus.UNPROCESSABLE_ENTITY);
    }

    await this.paymentService.editPaymentStatus(
      paymentStatus,
      constructedEvent.data.object.id,
    );

    if (paymentStatus === PaymentStatus.SUCCEEDED) {
      const orderId = await this.paymentService.getPaymentOrderId(
        constructedEvent.data.object.id,
      );
      await this.paymentService.orderCheckout(orderId);
    }

    throw new HttpException('', HttpStatus.NO_CONTENT);
  }

  @Post('/create-payment-intent')
  @UseGuards(JwtAuthGuard)
  async createPayment(
    @CurrentUser() user: UserEntity,
  ): Promise<StripePaymentIntent> {
    await this.nftLock.acquire(user.id);

    let stripePaymentIntent: StripePaymentIntent;
    try {
      // const createStripePayment (cookieSession, user)
      stripePaymentIntent = await this.paymentService.createStripePayment(user);
    } catch (err: any) {
      Logger.error(err);
      throw new HttpException(
        'Unable to place the order',
        HttpStatus.BAD_REQUEST,
      );
    } finally {
      this.nftLock.release(user.id);
    }
    return stripePaymentIntent;
  }
}
