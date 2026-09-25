import { Router } from "express";
import { ListBoards, GetBoard, CreateBoard, UpdateBoard, DeleteBoard, ProbeBoard } from "../controllers/boards.js";

const boardsRouter = Router();

boardsRouter.get('/', ListBoards);
boardsRouter.get('/:id', GetBoard);
boardsRouter.post('/', CreateBoard);
boardsRouter.put('/:id', UpdateBoard);
boardsRouter.delete('/:id', DeleteBoard);

boardsRouter.post('/:id/probe', ProbeBoard);

export default boardsRouter;