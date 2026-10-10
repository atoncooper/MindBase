-- 订单详情展示需要：付款账户（买家支付宝登录号/userId），由渠道查单或异步通知下发后落库。
ALTER TABLE pay_order ADD COLUMN buyer_logon_id varchar(64) NULL;
ALTER TABLE pay_order ADD COLUMN buyer_user_id varchar(64) NULL;
