# 发行版本

涉密离线版装配本地端点、离线许可证和空遥测；命令服务部署在本机回环地址。标准联网版装配固定 HTTPS 端点和在线许可证接口占位；命令服务部署位置是云端。

两版共用 RecognitionProvider、HttpCommandServiceClient、协议、CommandValidator、DocumentExecutor 接口和应用层 UseCase。
