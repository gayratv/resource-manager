// подписывается на событыие сервера и выполняет работу
import { ServerSocket } from './server-socket.js';
import type { Executor, GetNextClientJob, JobWorker, TBaseResultJob } from '../types/net-socket-types.js';
import {
  EventJobDoneArgs,
  QueueOneTypeProcessing,
  serverJobRecieved,
  workerJobDone,
} from '../types/net-socket-types.js';
import chalk from 'chalk';
import { delay } from '../helpers/common.js';

/*
В задачи worker входит обработка очереди сервера
worker получает событие о том что в очередь добавилась задача
Получив сообщение worker начинает обработку очереди и останавливается после того как обработал всю очередь

WorkerForServer на вход получает собственно обработчик - который обрабаытвает входящие сообщения и выдает результат

Refactor : сделаем несколько очередей для разных запросов (отдельную очередь для каждого типа сообщений)
 */

// внутри ServerSocket лежит очередь клиентских запросов
// queueClientsQuery: Record<string, ClientQuery> = {};
export class WorkerForServer<TresultJob extends TBaseResultJob> {
  private serverSocket: ServerSocket<TresultJob>;
  private registeredWorkers: Record<string, QueueOneTypeProcessing<TresultJob>> = {};
  constructor(ee: ServerSocket<TresultJob>) {
    this.serverSocket = ee;
    ee.on(serverJobRecieved, this.worker);
  }

  // запускаектся при появлении сообщения от сервера о том что пришло новое сообщение от клиента
  worker = (type: string) => {
    console.log('WorkerForServer : получено сообщение о задании ', type);

    let worker = this.registeredWorkers[type];

    if (!worker) {
      // такой обработчие не зарегистрирован
      console.error(chalk.red('Не найден обработчик для запроса '), type);
      const workJob: Executor<{ type: string; err: string }> = async (
        demand: GetNextClientJob,
      ): Promise<{ type: string; err: string }> => {
        return { type: type, err: `Не найден обработчик для запроса ` + type };
      };
      const jobWorker: JobWorker<{ type: string; err: string }> = {
        type: type,
        executor: workJob,
      };
      this.registerNewWorker(jobWorker as unknown as JobWorker<TresultJob>);
      worker = this.registeredWorkers[type];
    }

    // предотвратить многократный запуск обработчика задания
    if (!worker.demandQueIsProcessing) {
      worker.demandQueIsProcessing = true;
      setImmediate(this.processOneItem, type); // возможно что запустится еще один обработчик
    }
  };
  // обрабатывает один запрос из очереди
  processOneItem = async (type: string) => {
    const demand = this.serverSocket.getNextClientJobForType(type);
    // console.log('processOneItem demand ', demand);
    // console.timeLog('SRV1', 'processOneItem demand', demand?.queItem?.queryIndex, demand?.index);
    if (!demand) {
      //  признак того, что очередь type свободна
      if (this.registeredWorkers[type]) this.registeredWorkers[type].demandQueIsProcessing = false;
      return;
    }

    try {
      const workerForProcess = this.registeredWorkers[type];
      if (!workerForProcess) {
        console.error(chalk.red('Не найден обработчик для запроса '), type);
        const msgToServer: EventJobDoneArgs<TresultJob> = {
          demand,
          resultJob: {
            type: demand.queItem.type,
            err: `ERROR - could not process` + demand.queItem.type,
          } as unknown as TresultJob,
        };
        this.serverSocket.emit(workerJobDone, msgToServer);
      } else {
        workerForProcess.demandQueIsProcessing = true; // очередь type занята работой
        const result = await workerForProcess.runner(demand);
        const msgToServer: EventJobDoneArgs<TresultJob> = { demand, resultJob: result };
        this.serverSocket.emit(workerJobDone, msgToServer);
      }
    } catch (err) {
      // Job не смог быть выполнен, подождем 1 сек и попробуем еще
      await delay(1_000);
      this.serverSocket.putCurrentDemandToTheQueueEnd(demand);
    } finally {
      // продолжить обработку очереди пока в ней что то есть
      setImmediate(this.processOneItem, type);
    }
  };

  /*
   * регистрирует обработчика запроса типа type
   */
  registerNewWorker(workForJob: JobWorker<TresultJob>) {
    this.registeredWorkers[workForJob.type] = {
      type: workForJob.type,
      runner: workForJob.executor,
      demandQueIsProcessing: false,
    };
  }
}
